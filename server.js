require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, query, validationResult } = require('express-validator');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('ERROR: Set JWT_SECRET in .env (at least 32 characters). See .env.example');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: Set DATABASE_URL in .env. See .env.example');
  process.exit(1);
}

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = '8h';
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const CSRF_TTL_MS = 8 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// PostgreSQL Connection Pool
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// ---------------------------------------------------------------------------
// Schema Initialisation
// ---------------------------------------------------------------------------

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (username),
        UNIQUE (email)
      );

      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        party TEXT NOT NULL,
        packet_no INTEGER NOT NULL,
        customer_name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        item TEXT NOT NULL,
        item_name TEXT NOT NULL,
        amount REAL NOT NULL,
        quantity INTEGER NOT NULL,
        weight REAL NOT NULL,
        entry_date TEXT NOT NULL,
        release_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        rate_of_interest REAL NOT NULL,
        top_ups TEXT NOT NULL DEFAULT '[]',
        paid_ups TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (user_id, party, packet_no)
      );

      CREATE TABLE IF NOT EXISTS interest_payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        interest_start_date TEXT NOT NULL,
        interest_paid_till TEXT NOT NULL,
        interest_amount REAL NOT NULL,
        payment_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (record_id) REFERENCES records(id)
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    console.log('PostgreSQL schema ready.');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Email service — Brevo Transactional Email HTTPS API
// ---------------------------------------------------------------------------

async function sendPasswordResetEmail(toEmail, rawToken) {
  if (!process.env.BREVO_API_KEY) {
    console.error('EMAIL: BREVO_API_KEY is not configured. Cannot send password reset email.');
    return;
  }

  const resetLink = `${APP_BASE_URL}/reset-password.html?token=${rawToken}`;
  const senderEmail = process.env.SMTP_FROM;

  const payload = {
    sender:      { email: senderEmail },
    to:          [{ email: toEmail }],
    subject:     'Reset your Manibhadra Jewellers password',
    htmlContent: `
      <p>Hello,</p>
      <p>A password reset was requested for your Manibhadra Jewellers account.</p>
      <p>Click the button below to reset your password. This link expires in <strong>30 minutes</strong> and can only be used once.</p>
      <p style="margin:24px 0">
        <a href="${resetLink}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Reset Password</a>
      </p>
      <p>Or copy this link into your browser:</p>
      <p style="word-break:break-all;color:#555">${resetLink}</p>
      <p>If you did not request a password reset, you can safely ignore this email. Your password will not change.</p>
      <p>— Manibhadra Jewellers</p>
    `,
  };

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key':      process.env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const status = response.status;
    let detail = '';
    try { const j = await response.json(); detail = j.message || ''; } catch { /* ignore */ }
    console.error(`EMAIL: Brevo API returned HTTP ${status}${detail ? ': ' + detail : ''}`);
    throw new Error(`Brevo API error: HTTP ${status}`);
  }
}

// ---------------------------------------------------------------------------
// CSRF token store (in-memory, unchanged from SQLite version)
// ---------------------------------------------------------------------------

const csrfTokens = new Map();

function cleanupCsrfTokens() {
  const now = Date.now();
  for (const [token, meta] of csrfTokens.entries()) {
    if (meta.expiresAt <= now) csrfTokens.delete(token);
  }
}

setInterval(cleanupCsrfTokens, 30 * 60 * 1000);

function createCsrfToken(userId) {
  cleanupCsrfTokens();
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, { userId, expiresAt: Date.now() + CSRF_TTL_MS });
  return token;
}

function verifyCsrfToken(token, userId) {
  if (!token) return false;
  const meta = csrfTokens.get(token);
  if (!meta || meta.userId !== userId || meta.expiresAt <= Date.now()) {
    if (token) csrfTokens.delete(token);
    return false;
  }
  return true;
}

function revokeCsrfTokensForUser(userId) {
  for (const [token, meta] of csrfTokens.entries()) {
    if (meta.userId === userId) csrfTokens.delete(token);
  }
}

// ---------------------------------------------------------------------------
// Input validation helpers (unchanged)
// ---------------------------------------------------------------------------

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,128}$/;

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      error: errors.array()[0]?.msg || 'Invalid input.',
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Business logic helpers (unchanged — pure JS, no DB access)
// ---------------------------------------------------------------------------

function rowToRecord(row) {
  return {
    id: row.id,
    party: row.party,
    packetNo: row.packet_no,
    customerName: row.customer_name,
    phoneNumber: row.phone_number,
    item: row.item,
    itemName: row.item_name,
    amount: row.amount,
    quantity: row.quantity,
    weight: row.weight,
    entryDate: row.entry_date,
    releaseDate: row.release_date,
    status: row.status,
    rateOfInterest: row.rate_of_interest,
    topUps: JSON.parse(row.top_ups || '[]'),
    paidUps: JSON.parse(row.paid_ups || '[]'),
    interestPayments: [],
    createdAt: row.created_at,
  };
}

function getCurrentPrincipal(record) {
    let principal = Number(record.amount);
    const topUps = record.topUps || [];
    const paidUps = record.paidUps || [];
    topUps.forEach(topup => { principal += Number(topup.amount); });
    paidUps.forEach(paidup => { principal -= Number(paidup.amount); });
    return principal;
}

function calculateInterestForPeriod(record, startDate, endDate) {
    const roi = Number(record.rateOfInterest);
    let principal = Number(record.amount);
    const transactions = [];

    (record.topUps || []).forEach(topup => {
        transactions.push({ type: 'TOPUP', date: topup.date, amount: Number(topup.amount) });
    });

    (record.paidUps || []).forEach(paidup => {
        transactions.push({ type: 'PAIDUP', date: paidup.date, amount: Number(paidup.amount) });
    });

    transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Bring principal to the value on startDate
    for (const tx of transactions) {
        if (new Date(tx.date) < new Date(startDate)) {
            if (tx.type === 'TOPUP') principal += tx.amount;
            else principal -= tx.amount;
        }
    }

    let currentDate = startDate;
    let totalInterest = 0;

    for (const tx of transactions) {
        if (
            new Date(tx.date) < new Date(startDate) ||
            new Date(tx.date) > new Date(endDate)
        ) continue;

        const days =
          Math.floor(
              (new Date(tx.date) - new Date(currentDate))
              / (1000 * 60 * 60 * 24)
          ) + 1;

        totalInterest += (principal * roi * days) / (100 * 30);

        if (tx.type === 'TOPUP') principal += tx.amount;
        else principal -= tx.amount;

        currentDate = tx.date;
    }

    const remainingDays =
        Math.floor(
            (new Date(endDate) - new Date(currentDate))
            / (1000 * 60 * 60 * 24)
        ) + 1;

    totalInterest += (principal * roi * remainingDays) / (100 * 30);

    return totalInterest;
}


function getReleaseSummary(record) {
    if (record.status !== 'RELEASED') return null;

    const principalPaid = getCurrentPrincipal(record);

    const interestAlreadyPaid = (record.interestPayments || []).reduce(
        (sum, payment) => sum + Number(payment.amount),
        0
    );

    let interestStartDate;

    if (record.interestPayments.length > 0) {
        const lastPaidTill =
            record.interestPayments[record.interestPayments.length - 1].interestPaidTill;
        const nextDate = new Date(lastPaidTill);
        nextDate.setDate(nextDate.getDate() + 1);
        interestStartDate = nextDate.toISOString().split('T')[0];
    } else {
        interestStartDate = record.entryDate;
    }

    const remainingInterest = calculateInterestForPeriod(
        record,
        interestStartDate,
        record.releaseDate
    );

    const totalInterest = interestAlreadyPaid + remainingInterest;

    return {
        principalPaid,
        interestAlreadyPaid,
        remainingInterest,
        totalInterest,
        totalPaid: principalPaid + remainingInterest
    };
}


function addEntryTransaction(timeline, record) {
    timeline.push({
        type: 'ENTRY',
        date: record.entryDate,
        createdAt: record.createdAt,
        principal: Number(record.amount),
        title: 'Loan Entry'
    });
}

function addTopupTransactions(timeline, record) {
    (record.topUps || []).forEach(topup => {
        timeline.push({
            type: 'TOPUP',
            title: 'Top-Up',
            date: topup.date,
            createdAt: topup.createdAt,
            amount: Number(topup.amount)
        });
    });
}

function addPaidupTransactions(timeline, record) {
    (record.paidUps || []).forEach(paidup => {
        timeline.push({
            type: 'PAIDUP',
            title: 'Paid-Up',
            date: paidup.date,
            createdAt: paidup.createdAt,
            amount: Number(paidup.amount)
        });
    });
}

function addInterestTransactions(timeline, record) {
    (record.interestPayments || []).forEach(payment => {
        timeline.push({
            type: 'INTEREST',
            title: 'Interest Payment',
            date: payment.date,
            createdAt: payment.createdAt,
            amount: Number(payment.amount),
            paidTill: payment.interestPaidTill
        });
    });
}

function addReleaseTransaction(timeline, record) {
    if (record.status !== 'RELEASED') return;
    const release = getReleaseSummary(record);
    timeline.push({
        type: 'RELEASE',
        title: 'Release',
        date: record.releaseDate,
        principalPaid: release.principalPaid,
        interestPaid: release.remainingInterest,
        totalPaid: release.totalPaid
    });
}

function buildLedgerTimeline(record) {
    const timeline = [];

    addEntryTransaction(timeline, record);
    addTopupTransactions(timeline, record);
    addPaidupTransactions(timeline, record);
    addInterestTransactions(timeline, record);
    addReleaseTransaction(timeline, record);

    timeline.sort((a, b) => {
        const dateDiff = new Date(a.date) - new Date(b.date);
        if (dateDiff !== 0) return dateDiff;
        const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return createdA - createdB;
    });

    let principal = Number(record.amount);

    timeline.forEach(event => {
        switch (event.type) {
            case 'ENTRY':
                event.principalAfter = principal;
                break;
            case 'TOPUP':
                principal += event.amount;
                event.principalAfter = principal;
                break;
            case 'PAIDUP':
                principal -= event.amount;
                event.principalAfter = principal;
                break;
            case 'INTEREST':
                event.principalAfter = principal;
                break;
            case 'RELEASE':
                event.principalAfter = principal;
                break;
        }
    });

    return timeline;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, tv: user.token_version },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY, issuer: 'manibhadra-jewellers' }
  );
}

function setAuthCookie(res, token) {
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/',
  });
}

async function authenticate(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'manibhadra-jewellers' });
    const user = await getUserById(payload.sub);
    if (!user || user.token_version !== payload.tv) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
    };
    next();
  } catch {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

function requireCsrf(req, res, next) {
  const csrfHeader = req.get('X-CSRF-Token');
  if (!verifyCsrfToken(csrfHeader, req.user.id)) {
    return res.status(403).json({ error: 'Invalid security token. Refresh and try again.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const app = express();

app.use(
  helmet({
    hidePoweredBy: true,
    noSniff: true,
    referrerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    strictTransportSecurity: IS_PRODUCTION
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,

    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait and try again.' },
  handler: (req, res) => {
    console.warn(`SECURITY: Authentication rate limit exceeded for ${req.path}.`);
    res.status(429).json({
      error: 'Too many attempts. Please wait and try again.'
    });
  },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api', apiLimiter);

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------

app.post(
  '/api/auth/register',
  [
    body('username')
      .isString()
      .trim()
      .isLength({ min: 3, max: 30 })
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage('Username must be 3–30 characters (letters, numbers, underscore only).'),
    body('email').isString().trim().isEmail().normalizeEmail().withMessage('Enter a valid email address.'),
    body('password')
      .isString()
      .isLength({ min: 8, max: 128 })
      .matches(PASSWORD_REGEX)
      .withMessage(
        'Password must be 8–128 characters with uppercase, lowercase, number, and special character.'
      ),
    body('confirmPassword').isString().custom((value, { req }) => {
      if (value !== req.body.password) throw new Error('Passwords do not match.');
      return true;
    }),
  ],
  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const { username, email, password } = req.body;

      const existing = await pool.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
        [username, email]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Username or email is already registered.' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      await pool.query(
        `INSERT INTO users (id, username, email, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, username, email, passwordHash, createdAt]
      );

      res.status(201).json({ message: 'Account created successfully. You can now log in.' });
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  '/api/auth/login',
  [
    body('identifier')
      .isString()
      .trim()
      .isLength({ min: 1, max: 254 })
      .withMessage('Username or email is invalid.'),
    body('password')
      .isString()
      .isLength({ min: 1, max: 128 })
      .withMessage('Invalid password.'),
  ],
  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const identifier = req.body.identifier.trim();
      const password = req.body.password;

      const userResult = await pool.query(
        `SELECT * FROM users
         WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)`,
        [identifier, identifier]
      );

      const user = userResult.rows[0] || null;

      if (!user) {
        await bcrypt.hash(password, BCRYPT_ROUNDS);
        console.warn('SECURITY: Failed login attempt - account not found.');
        return res.status(401).json({ error: 'Invalid username/email or password.' });
      }

      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
        return res.status(429).json({
          error: `Account temporarily locked. Try again in about ${minutesLeft} minute(s).`,
        });
      }

      const passwordValid = await bcrypt.compare(password, user.password_hash);

      if (!passwordValid) {
        const attempts = user.failed_login_attempts + 1;
        console.warn(`SECURITY: Failed login attempt for user ID ${user.id}.`);
        let lockedUntil = null;
        if (attempts >= LOCKOUT_ATTEMPTS) {
          lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
        }
        await pool.query(
          `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
          [attempts, lockedUntil, user.id]
        );

        if (lockedUntil) {
          return res.status(429).json({
            error: 'Too many failed attempts. Account locked for 15 minutes.',
          });
        }
        return res.status(401).json({ error: 'Invalid username/email or password.' });
      }

      await pool.query(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
        [user.id]
      );

      console.log(`SECURITY: Successful login for user ID ${user.id}.`);

      revokeCsrfTokensForUser(user.id);
      const token = signToken(user);
      const csrfToken = createCsrfToken(user.id);
      setAuthCookie(res, token);

      res.json({
        user: { username: user.username, email: user.email },
        csrfToken,
      });
    } catch (err) {
      next(err);
    }
  }
);

app.post('/api/auth/logout', authenticate, requireCsrf, async (req, res, next) => {
  try {
    const user = await getUserById(req.user.id);
    if (user) {
      await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [user.id]);
      revokeCsrfTokensForUser(user.id);
    }
    clearAuthCookie(res);
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  const csrfToken = createCsrfToken(req.user.id);
  res.json({
    user: { username: req.user.username, email: req.user.email },
    csrfToken,
  });
});

// ---------------------------------------------------------------------------
// FORGOT PASSWORD
// ---------------------------------------------------------------------------

app.post(
  '/api/auth/forgot-password',
  [
    body('email').isString().trim().isEmail().normalizeEmail().withMessage('Enter a valid email address.'),
  ],
  async (req, res, next) => {
    const GENERIC_RESPONSE = { message: 'If an account exists for this email, a password reset link has been sent.' };
    try {
      if (validationErrors(req, res)) return;

      const email = req.body.email;

      const userResult = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      const user = userResult.rows[0] || null;

      if (!user) {
        // Do not reveal whether the account exists
        return res.json(GENERIC_RESPONSE);
      }

      // Invalidate any previous unused tokens for this user
      await pool.query(
        `UPDATE password_reset_tokens SET used = 1 WHERE user_id = $1 AND used = 0`,
        [user.id]
      );

      // Generate a cryptographically secure raw token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const tokenId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      const createdAt = new Date().toISOString();

      await pool.query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used, created_at)
         VALUES ($1, $2, $3, $4, 0, $5)`,
        [tokenId, user.id, tokenHash, expiresAt, createdAt]
      );

      // Send email (non-blocking on send failure — still respond generically)
      try {
        await sendPasswordResetEmail(user.email, rawToken);
      } catch (emailErr) {
        console.error('EMAIL: Failed to send password reset email:', emailErr.message);
      }

      res.json(GENERIC_RESPONSE);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// RESET PASSWORD
// ---------------------------------------------------------------------------

app.post(
  '/api/auth/reset-password',
  [
    body('token').isString().trim().isLength({ min: 1, max: 128 }).withMessage('Invalid reset token.'),
    body('password')
      .isString()
      .isLength({ min: 8, max: 128 })
      .matches(PASSWORD_REGEX)
      .withMessage('Password must be 8–128 characters with uppercase, lowercase, number, and special character.'),
    body('confirmPassword').isString().custom((value, { req }) => {
      if (value !== req.body.password) throw new Error('Passwords do not match.');
      return true;
    }),
  ],
  async (req, res, next) => {
    const INVALID_TOKEN_MSG = 'This password reset link is invalid or has expired. Please request a new one.';
    try {
      if (validationErrors(req, res)) return;

      const { token, password } = req.body;

      // Hash the submitted token to compare against stored hash
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const tokenResult = await pool.query(
        `SELECT * FROM password_reset_tokens WHERE token_hash = $1`,
        [tokenHash]
      );
      const tokenRow = tokenResult.rows[0] || null;

      if (!tokenRow) {
        return res.status(400).json({ error: INVALID_TOKEN_MSG });
      }

      if (tokenRow.used) {
        return res.status(400).json({ error: INVALID_TOKEN_MSG });
      }

      if (new Date(tokenRow.expires_at) <= new Date()) {
        return res.status(400).json({ error: INVALID_TOKEN_MSG });
      }

      const user = await getUserById(tokenRow.user_id);
      if (!user) {
        return res.status(400).json({ error: INVALID_TOKEN_MSG });
      }

      // Hash new password with same bcrypt configuration as registration
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // Update password and increment token_version to invalidate existing sessions
      await pool.query(
        `UPDATE users SET password_hash = $1, token_version = token_version + 1,
         failed_login_attempts = 0, locked_until = NULL WHERE id = $2`,
        [passwordHash, user.id]
      );

      // Mark reset token as used
      await pool.query(
        `UPDATE password_reset_tokens SET used = 1 WHERE id = $1`,
        [tokenRow.id]
      );

      // Revoke CSRF tokens for existing sessions
      revokeCsrfTokensForUser(user.id);

      // Clear auth cookie in case user is currently logged in
      clearAuthCookie(res);

      res.json({ message: 'Password has been reset successfully. You can now log in with your new password.' });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// REPORTS - EXISTING CUSTOMERS
// ============================================================

app.get(
  '/api/reports/existing-customers',
  authenticate,
  [
    query('party').isString().trim().notEmpty().isLength({ max: 30 }).withMessage('Invalid party.'),
    query('date').isString().isISO8601({ strict: false }).withMessage('Invalid report date.')
  ],
  async (req, res, next) => {

    if (validationErrors(req, res)) return;

    const { party, date } = req.query;

    try {

      /*
       * Get all customers belonging to the logged-in user
       * and selected party.
       */
      const rowsResult = await pool.query(
        `SELECT * FROM records WHERE user_id = $1 AND party = $2 ORDER BY packet_no`,
        [req.user.id, party]
      );

      const rows = rowsResult.rows;
      const reportRecords = [];

      for (const row of rows) {

        const record = rowToRecord(row);

        /*
         * A customer is considered "existing" as of the
         * selected report date if:
         *
         * 1. Their entry date is on/before the report date.
         * 2. They were not released on/before the report date.
         */
        if (new Date(record.entryDate) > new Date(date)) {
          continue;
        }

        if (
          record.status === 'RELEASED' &&
          record.releaseDate &&
          new Date(record.releaseDate) <= new Date(date)
        ) {
          continue;
        }


        /*
         * ----------------------------------------------------
         * Current Principal as of report date
         * ----------------------------------------------------
         */

        let currentPrincipal = Number(record.amount);

        const topUpsTillDate =
          (record.topUps || []).filter(
            topup => new Date(topup.date) <= new Date(date)
          );

        const paidUpsTillDate =
          (record.paidUps || []).filter(
            paidup => new Date(paidup.date) <= new Date(date)
          );

        topUpsTillDate.forEach(topup => { currentPrincipal += Number(topup.amount); });
        paidUpsTillDate.forEach(paidup => { currentPrincipal -= Number(paidup.amount); });


        /*
         * ----------------------------------------------------
         * Interest Payments Till Report Date
         * ----------------------------------------------------
         */

        const ipResult = await pool.query(
          `SELECT payment_date, interest_paid_till, interest_amount
           FROM interest_payments
           WHERE record_id = $1 AND interest_paid_till <= $2
           ORDER BY interest_paid_till`,
          [row.id, date]
        );

        const interestPayments = ipResult.rows;

        const interestPaid = interestPayments.reduce(
          (sum, payment) => sum + Number(payment.interest_amount),
          0
        );


        /*
         * ----------------------------------------------------
         * Interest Accrued Till Report Date
         * ----------------------------------------------------
         */

        const interestAccrued = calculateInterestForPeriod(
          {
            ...record,
            topUps: topUpsTillDate,
            paidUps: paidUpsTillDate
          },
          record.entryDate,
          date
        );


        /*
         * Interest that has accrued but has not yet been paid.
         */
        const pendingInterest = Math.max(0, interestAccrued - interestPaid);

        /*
         * Total amount recoverable as of the selected report date.
         */
        const totalRecoverable = currentPrincipal + pendingInterest;

        reportRecords.push({
          packetNo: record.packetNo,
          customerName: record.customerName,
          phoneNumber: record.phoneNumber,
          entryDate: record.entryDate,
          initialPrincipal: Number(record.amount),
          currentPrincipal,
          rateOfInterest: Number(record.rateOfInterest),
          interestAccrued,
          interestPaid,
          pendingInterest,
          totalRecoverable
        });

      }


      /*
       * ----------------------------------------------------
       * Report Summary
       * ----------------------------------------------------
       */

      const summary = {
        totalCustomers: reportRecords.length,
        totalInitialPrincipal: reportRecords.reduce((sum, c) => sum + c.initialPrincipal, 0),
        totalCurrentPrincipal: reportRecords.reduce((sum, c) => sum + c.currentPrincipal, 0),
        totalInterestAccrued: reportRecords.reduce((sum, c) => sum + c.interestAccrued, 0),
        totalInterestPaid: reportRecords.reduce((sum, c) => sum + c.interestPaid, 0),
        totalPendingInterest: reportRecords.reduce((sum, c) => sum + c.pendingInterest, 0),
        totalRecoverable: reportRecords.reduce((sum, c) => sum + c.totalRecoverable, 0)
      };

      res.json({
        reportType: 'existing',
        party,
        reportDate: date,
        summary,
        records: reportRecords
      });

    }
    catch (err) {
      console.error('Existing customers report error:', err);
      res.status(500).json({ error: 'Failed to generate existing customers report.' });
    }

  }
);

// ============================================================
// GET /api/records  — list / search records
// ============================================================

app.get(
  '/api/records',
  authenticate,
  [
    query('party')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 30 })
      .withMessage('Invalid party.'),

    query('packetNo')
      .optional()
      .isInt({ min: 1, max: 1000000000 })
      .withMessage('Invalid packet number.'),

    query('name')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Invalid customer name.'),
  ],
  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const { party, packetNo, name } = req.query;

      let rowsResult = await pool.query(
        'SELECT * FROM records WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.id]
      );

      let rows = rowsResult.rows;

      if (party) rows = rows.filter((r) => r.party === party);
      if (packetNo) rows = rows.filter((r) => r.packet_no === Number(packetNo));
      if (name) {
        const q = name.toLowerCase();
        rows = rows.filter((r) => r.customer_name.toLowerCase().includes(q));
      }

      const records = await Promise.all(rows.map(async (row) => {
          const record = rowToRecord(row);

          const ipResult = await pool.query(
            `SELECT payment_date, interest_paid_till, interest_amount
             FROM interest_payments
             WHERE record_id = $1 AND user_id = $2
             ORDER BY payment_date`,
            [row.id, req.user.id]
          );

          record.interestPayments = ipResult.rows.map(item => ({
            date: item.payment_date,
            interestPaidTill: item.interest_paid_till,
            amount: item.interest_amount
          }));

          record.hasTransactions =
              record.topUps.length > 0 ||
              record.paidUps.length > 0 ||
              record.interestPayments.length > 0;

          return record;
      }));

      res.json({ records });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// GET /api/ledger
// ============================================================

app.get(
  '/api/ledger',
  authenticate,
  [
    query('party')
      .isString()
      .trim()
      .isLength({ min: 1, max: 30 })
      .withMessage('Invalid party.'),

    query('packetNo')
      .optional()
      .isInt({ min: 1, max: 1000000000 })
      .withMessage('Invalid packet number.'),

    query('name')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Invalid customer name.'),
  ],
  async (req, res, next) => {

    try {

        if (validationErrors(req, res)) return;

        const { packetNo, name, party } = req.query;

        let row = null;

        if (packetNo) {

            const result = await pool.query(
              `SELECT * FROM records
               WHERE user_id = $1 AND party = $2 AND packet_no = $3`,
              [req.user.id, party, packetNo]
            );
            row = result.rows[0] || null;

        }
        else if (name) {

            const result = await pool.query(
              `SELECT * FROM records
               WHERE user_id = $1 AND party = $2 AND LOWER(customer_name) LIKE LOWER($3)
               ORDER BY customer_name`,
              [req.user.id, party, `%${name}%`]
            );

            return res.json({
                records: result.rows.map(rowToRecord)
            });

        }
        else {

            return res.status(400).json({
                error: 'Packet Number or Customer Name is required.'
            });

        }

        if (!row) {
            return res.status(404).json({ error: 'Customer not found.' });
        }

        const record = rowToRecord(row);

        // Interest Payment History
        const ipResult = await pool.query(
          `SELECT payment_date, interest_paid_till, interest_amount, created_at
           FROM interest_payments
           WHERE record_id = $1
           ORDER BY payment_date`,
          [row.id]
        );

        record.interestPayments = ipResult.rows.map(payment => ({
            date: payment.payment_date,
            createdAt: payment.created_at,
            interestPaidTill: payment.interest_paid_till,
            amount: Number(payment.interest_amount)
        }));


        const summary = {
            currentPrincipal: getCurrentPrincipal(record),
            totalInterestPaid: record.interestPayments.reduce(
                (sum, payment) => sum + payment.amount,
                0
            ),
            topupCount: record.topUps.length,
            paidupCount: record.paidUps.length
        };

        const timeline = buildLedgerTimeline(record);

        res.json({ record, summary, timeline });

    }

    catch (err) {
        next(err);
    }

});

// ============================================================
// POST /api/records — create record
// ============================================================

app.post(
  '/api/records',
  authenticate,
  requireCsrf,
  [
    body('party')
      .isString()
      .trim()
      .isLength({ min: 1, max: 30 })
      .withMessage('Invalid party.'),
    body('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.'),
    body('customerName').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Invalid customer name.'),
    body('phoneNumber')
      .isString()
      .trim()
      .matches(/^[0-9]{10}$/)
      .withMessage('Phone number must be exactly 10 digits.'),

    body('item')
      .isString()
      .isIn(['Gold', 'Silver', 'Both'])
      .withMessage('Invalid item.'),
    body('itemName').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Invalid item name.'),

    body('amount')
      .isFloat({ min: 0, max: 1000000000 })
      .withMessage('Invalid amount.')
      .custom(Number.isFinite)
      .withMessage('Amount must be a finite number.'),

    body('quantity')
      .isInt({ min: 1, max: 100000 })
      .withMessage('Invalid quantity.'),

    body('weight')
      .isFloat({ min: 0, max: 1000000 })
      .withMessage('Invalid weight.')
      .custom(Number.isFinite)
      .withMessage('Weight must be a finite number.'),

    body('entryDate').isString().isISO8601({ strict: false }).withMessage('Invalid entry date.'),

    body('rateOfInterest')
      .isFloat({ min: 0, max: 100 })
      .withMessage('Invalid interest rate.')
      .custom(Number.isFinite)
      .withMessage('Interest rate must be a finite number.'),
  ],
  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

    const {
      party,
      packetNo,
      customerName,
      phoneNumber,
      item,
      itemName,
      amount,
      quantity,
      weight,
      entryDate,
      rateOfInterest,
    } = req.body;

    const existing = await pool.query(
      'SELECT id FROM records WHERE user_id = $1 AND party = $2 AND packet_no = $3',
      [req.user.id, party, packetNo]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: `Packet ${packetNo} already exists for ${party}.` });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await pool.query(
      `INSERT INTO records (
        id, user_id, party, packet_no, customer_name, phone_number,
        item, item_name, amount, quantity, weight,
        entry_date, release_date, status, rate_of_interest,
        top_ups, paid_ups, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id,
        req.user.id,
        party,
        packetNo,
        customerName,
        phoneNumber,
        item,
        itemName,
        amount,
        quantity,
        weight,
        entryDate,
        '',          // Temporary release date
        'ACTIVE',
        rateOfInterest,
        '[]',
        '[]',
        createdAt
      ]
    );

    const rowResult = await pool.query(
      'SELECT * FROM records WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    res.status(201).json({ record: rowToRecord(rowResult.rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// POST /api/records/topup
// ============================================================

app.post(
  '/api/records/topup',
  authenticate,
  requireCsrf,
  [
    body('party')
      .isString()
      .trim()
      .isLength({ min: 1, max: 30 })
      .withMessage('Invalid party.'),
    body('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.'),
    body('amount')
      .isFloat({ min: 0.01, max: 1000000000 })
      .withMessage('Invalid top-up amount.')
      .custom(Number.isFinite)
      .withMessage('Top-up amount must be a finite number.'),
    body('date').isString().isISO8601({ strict: false }).withMessage('Invalid top-up date.'),
  ],
  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const { party, packetNo, amount, date } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const rowResult = await client.query(
          'SELECT * FROM records WHERE user_id = $1 AND party = $2 AND packet_no = $3',
          [req.user.id, party, packetNo]
        );
        const row = rowResult.rows[0];

        if (!row) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: `No record found for Packet ${packetNo} under ${party}.` });
        }

        if (row.status === 'RELEASED') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Customer has already been released. Top-Up is not allowed.' });
        }

        if (new Date(date) <= new Date(row.entry_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Top-up date must be after the entry date.' });
        }
        if (row.release_date && new Date(date) >= new Date(row.release_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Top-up date must be before the release date.' });
        }

        const topUps = JSON.parse(row.top_ups || '[]');
        topUps.push({ date, amount: Number(amount), createdAt: new Date().toISOString() });
        topUps.sort((a, b) => new Date(a.date) - new Date(b.date));

        await client.query(
          'UPDATE records SET top_ups = $1 WHERE id = $2 AND user_id = $3',
          [JSON.stringify(topUps), row.id, req.user.id]
        );

        const updatedResult = await client.query(
          'SELECT * FROM records WHERE id = $1 AND user_id = $2',
          [row.id, req.user.id]
        );

        await client.query('COMMIT');
        res.status(200).json({ record: rowToRecord(updatedResult.rows[0]) });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// POST /api/records/paidup
// ============================================================

app.post(
  '/api/records/paidup',
  authenticate,
  requireCsrf,
  [
    body('party')
      .isString()
      .trim()
      .isLength({ min: 1, max: 30 })
      .withMessage('Invalid party.'),
    body('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.'),
    body('amount')
      .isFloat({ min: 0.01, max: 1000000000 })
      .withMessage('Invalid paid-up amount.')
      .custom(Number.isFinite)
      .withMessage('Paid-up amount must be a finite number.'),
    body('date').isString().isISO8601({ strict: false }).withMessage('Invalid paid-up date.'),
  ],
  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const { party, packetNo, amount, date } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const rowResult = await client.query(
          'SELECT * FROM records WHERE user_id = $1 AND party = $2 AND packet_no = $3',
          [req.user.id, party, packetNo]
        );
        const row = rowResult.rows[0];

        if (!row) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: `No record found for Packet ${packetNo} under ${party}.` });
        }

        if (row.status === 'RELEASED') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Customer has already been released. Paid-Up is not allowed.' });
        }

        if (new Date(date) <= new Date(row.entry_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Paid-Up date must be after the entry date.' });
        }
        if (row.release_date && new Date(date) >= new Date(row.release_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Paid-Up date must be before the release date.' });
        }

        const paidUps = JSON.parse(row.paid_ups || '[]');
        paidUps.push({ date, amount: Number(amount), createdAt: new Date().toISOString() });
        paidUps.sort((a, b) => new Date(a.date) - new Date(b.date));

        await client.query(
          'UPDATE records SET paid_ups = $1 WHERE id = $2 AND user_id = $3',
          [JSON.stringify(paidUps), row.id, req.user.id]
        );

        const updatedResult = await client.query(
          'SELECT * FROM records WHERE id = $1 AND user_id = $2',
          [row.id, req.user.id]
        );

        await client.query('COMMIT');
        res.status(200).json({ record: rowToRecord(updatedResult.rows[0]) });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// PUT /api/records/edit
// ============================================================

app.put(
  '/api/records/edit',
  authenticate,
  requireCsrf,
  [
    body('party')
      .isString()
      .trim()
      .isLength({ min: 1, max: 30 })
      .withMessage('Invalid party.'),
    body('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.'),

    body('customerName').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Invalid customer name.'),

    body('phoneNumber')
      .isString()
      .trim()
      .matches(/^[0-9]{10}$/)
      .withMessage('Phone number must be exactly 10 digits.'),

    body('item')
      .isString()
      .isIn(['Gold', 'Silver', 'Both'])
      .withMessage('Invalid item.'),

    body('itemName').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Invalid item name.'),

    body('amount')
      .isFloat({ min: 0, max: 1000000000 })
      .withMessage('Invalid amount.')
      .custom(Number.isFinite)
      .withMessage('Amount must be a finite number.'),

    body('quantity')
      .isInt({ min: 1, max: 100000 })
      .withMessage('Invalid quantity.'),

    body('weight')
      .isFloat({ min: 0, max: 1000000 })
      .withMessage('Invalid weight.')
      .custom(Number.isFinite)
      .withMessage('Weight must be a finite number.'),

    body('entryDate').isString().isISO8601({ strict: false }).withMessage('Invalid entry date.'),

    body('rateOfInterest')
      .isFloat({ min: 0, max: 100 })
      .withMessage('Invalid interest rate.')
      .custom(Number.isFinite)
      .withMessage('Interest rate must be a finite number.'),
  ],

  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const {
        party,
        packetNo,
        customerName,
        phoneNumber,
        item,
        itemName,
        amount,
        quantity,
        weight,
        entryDate,
        rateOfInterest,
      } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const rowResult = await client.query(
          `SELECT * FROM records
           WHERE user_id = $1 AND party = $2 AND packet_no = $3`,
          [req.user.id, party, packetNo]
        );
        const row = rowResult.rows[0];

        if (!row) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Customer not found.' });
        }

        const ipCountResult = await client.query(
          `SELECT COUNT(*) AS count FROM interest_payments
           WHERE record_id = $1 AND user_id = $2`,
          [row.id, req.user.id]
        );

        const hasTransactions =
            JSON.parse(row.top_ups || '[]').length > 0 ||
            JSON.parse(row.paid_ups || '[]').length > 0 ||
            Number(ipCountResult.rows[0].count) > 0;

        if (hasTransactions) {

            await client.query(
              `UPDATE records
               SET customer_name = $1, phone_number = $2, item = $3,
                   item_name = $4, quantity = $5, weight = $6, entry_date = $7
               WHERE id = $8 AND user_id = $9`,
              [customerName, phoneNumber, item, itemName, quantity, weight, entryDate, row.id, req.user.id]
            );

        } else {

            await client.query(
              `UPDATE records
               SET customer_name = $1, phone_number = $2, item = $3,
                   item_name = $4, amount = $5, quantity = $6, weight = $7,
                   entry_date = $8, rate_of_interest = $9
               WHERE id = $10 AND user_id = $11`,
              [customerName, phoneNumber, item, itemName, amount, quantity, weight, entryDate, rateOfInterest, row.id, req.user.id]
            );

        }

        const updatedResult = await client.query(
          'SELECT * FROM records WHERE id = $1 AND user_id = $2',
          [row.id, req.user.id]
        );

        await client.query('COMMIT');
        res.status(200).json({ record: rowToRecord(updatedResult.rows[0]) });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// PUT /api/records/release
// ============================================================

app.put(
  '/api/records/release',
  authenticate,
  requireCsrf,
  [
    body('party')
      .isString()
      .trim()
      .isLength({ min: 1, max: 30 })
      .withMessage('Invalid party.'),
    body('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.'),
    body('releaseDate').isString().isISO8601({ strict: false }).withMessage('Invalid release date.'),
  ],

  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const { party, packetNo, releaseDate } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const rowResult = await client.query(
          `SELECT * FROM records
           WHERE user_id = $1 AND party = $2 AND packet_no = $3`,
          [req.user.id, party, packetNo]
        );
        const row = rowResult.rows[0];

        if (!row) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Customer not found.' });
        }

        const interestHistoryResult = await client.query(
          `SELECT interest_paid_till, interest_amount
           FROM interest_payments
           WHERE record_id = $1 AND user_id = $2
           ORDER BY interest_paid_till`,
          [row.id, req.user.id]
        );
        const interestHistory = interestHistoryResult.rows;

        const interestAlreadyPaid = interestHistory.reduce(
          (sum, item) => sum + item.interest_amount,
          0
        );

        const lastInterestPaidTill =
          interestHistory.length > 0
            ? interestHistory[interestHistory.length - 1].interest_paid_till
            : null;

        if (row.status === 'RELEASED') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Customer is already released.' });
        }

        if (new Date(releaseDate) <= new Date(row.entry_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Release Date must be after Entry Date.' });
        }

        const topUps = JSON.parse(row.top_ups || '[]');
        if (topUps.length > 0) {
            const lastTopUp = topUps[topUps.length - 1];
            if (new Date(releaseDate) <= new Date(lastTopUp.date)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Release Date must be after the latest Top-Up.' });
            }
        }

        const paidUps = JSON.parse(row.paid_ups || '[]');
        if (paidUps.length > 0) {
            const lastPaidUp = paidUps[paidUps.length - 1];
            if (new Date(releaseDate) <= new Date(lastPaidUp.date)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Release Date must be after the latest Paid-Up.' });
            }
        }

        if (
            lastInterestPaidTill &&
            new Date(releaseDate) < new Date(lastInterestPaidTill)
        ) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Release Date cannot be before the latest Interest Payment.' });
        }

        let interestStartDate;
        if (lastInterestPaidTill) {
            const nextDate = new Date(lastInterestPaidTill);
            nextDate.setDate(nextDate.getDate() + 1);
            interestStartDate = nextDate.toISOString().split('T')[0];
        } else {
            interestStartDate = row.entry_date;
        }

        const remainingInterest = calculateInterestForPeriod(
            rowToRecord(row),
            interestStartDate,
            releaseDate
        );

        const totalInterest = interestAlreadyPaid + remainingInterest;

        await client.query(
          `UPDATE records SET release_date = $1, status = 'RELEASED'
           WHERE id = $2 AND user_id = $3`,
          [releaseDate, row.id, req.user.id]
        );

        const updatedResult = await client.query(
          'SELECT * FROM records WHERE id = $1 AND user_id = $2',
          [row.id, req.user.id]
        );

        await client.query('COMMIT');
        res.status(200).json({
          record: rowToRecord(updatedResult.rows[0]),
          totalInterest,
          interestAlreadyPaid,
          remainingInterest
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// GET /api/interest-payment/search
// ============================================================

app.get(
  '/api/interest-payment/search',
  authenticate,
  [
    query('party').isString().trim().notEmpty().isLength({ max: 30 }).withMessage('Invalid party.'),
    query('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.')
  ],

  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const { party, packetNo } = req.query;

      const recordResult = await pool.query(
        `SELECT * FROM records
         WHERE user_id = $1 AND party = $2 AND packet_no = $3`,
        [req.user.id, party, Number(packetNo)]
      );

      const record = recordResult.rows[0];

      if (!record) {
        return res.status(404).json({ error: 'Customer not found.' });
      }

      const historyResult = await pool.query(
        `SELECT interest_start_date, interest_paid_till, interest_amount, payment_date
         FROM interest_payments
         WHERE record_id = $1 AND user_id = $2
         ORDER BY interest_paid_till`,
        [record.id, req.user.id]
      );

      const history = historyResult.rows;

      const totalInterestPaid = history.reduce(
        (sum, item) => sum + item.interest_amount,
        0
      );

      const lastInterestPaidTill =
        history.length > 0
          ? history[history.length - 1].interest_paid_till
          : null;

      res.json({
        record: rowToRecord(record),
        lastInterestPaidTill,
        totalInterestPaid,
        history
      });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// POST /api/interest-payment
// ============================================================

app.post(
  '/api/interest-payment',

  authenticate,

  requireCsrf,

  [
    body('recordId').isString().trim().notEmpty().withMessage('Invalid record ID.'),
    body('interestStartDate').isString().isISO8601({ strict: false }).withMessage('Invalid start date.'),
    body('interestPaidTill').isString().isISO8601({ strict: false }).withMessage('Invalid paid till date.')
  ],

  async (req, res, next) => {
    try {
      if (validationErrors(req, res)) return;

      const { recordId, interestStartDate, interestPaidTill } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const recordResult = await client.query(
          `SELECT * FROM records WHERE id = $1 AND user_id = $2`,
          [recordId, req.user.id]
        );
        const record = recordResult.rows[0];

        if (!record) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Customer not found.' });
        }

        if (record.status === 'RELEASED') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Interest payment cannot be added. Customer has already been released.' });
        }

        const lastPaymentResult = await client.query(
          `SELECT interest_start_date, interest_paid_till
           FROM interest_payments
           WHERE record_id = $1 AND user_id = $2
           ORDER BY interest_paid_till DESC
           LIMIT 1`,
          [recordId, req.user.id]
        );
        const lastPayment = lastPaymentResult.rows[0] || null;

        const numberOfDays =
          Math.floor(
            (new Date(interestPaidTill) - new Date(interestStartDate))
            / (1000 * 60 * 60 * 24)
          ) + 1;

        let expectedStartDate;

        if (lastPayment) {
            const nextDate = new Date(lastPayment.interest_paid_till);
            nextDate.setDate(nextDate.getDate() + 1);
            expectedStartDate = nextDate.toISOString().split('T')[0];
        } else {
            expectedStartDate = record.entry_date;
        }

        if (interestStartDate !== expectedStartDate) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Interest Start Date must be ${expectedStartDate}.` });
        }

        if (new Date(interestPaidTill) <= new Date(interestStartDate)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Interest Paid Till date must be after Interest Start Date.' });
        }

        const duplicateResult = await client.query(
          `SELECT id FROM interest_payments
           WHERE record_id = $1 AND interest_paid_till = $2 AND user_id = $3`,
          [recordId, interestPaidTill, req.user.id]
        );

        if (duplicateResult.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Interest for this period has already been recorded.' });
        }

        const calculatedInterest = calculateInterestForPeriod(
            rowToRecord(record),
            interestStartDate,
            interestPaidTill
        );

        const id = crypto.randomUUID();
        const today = new Date().toISOString().split('T')[0];
        const createdAt = new Date().toISOString();

        await client.query(
          `INSERT INTO interest_payments (
            id, user_id, record_id, interest_start_date,
            interest_paid_till, interest_amount, payment_date, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, req.user.id, recordId, interestStartDate, interestPaidTill, calculatedInterest, today, createdAt]
        );

        await client.query('COMMIT');
        res.status(200).json({
          message: 'Interest payment saved successfully.',
          interestAmount: calculatedInterest,
          numberOfDays,
          interestStartDate,
          interestPaidTill
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// POST /api/records/release-preview
// ============================================================

app.post(
  '/api/records/release-preview',

  authenticate,

  requireCsrf,

  [
    body('party')
      .isString()
      .trim()
      .isLength({ min: 1, max: 30 })
      .withMessage('Invalid party.'),

    body('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.'),

    body('releaseDate').isString().isISO8601({ strict: false }).withMessage('Invalid release date.')
  ],

  async (req, res, next) => {
    try {

      if (validationErrors(req, res)) return;

      const { party, packetNo, releaseDate } = req.body;

      const rowResult = await pool.query(
        `SELECT * FROM records
         WHERE user_id = $1 AND party = $2 AND packet_no = $3`,
        [req.user.id, party, packetNo]
      );

      const row = rowResult.rows[0];

      if (!row) {
        return res.status(404).json({ error: 'Customer not found.' });
      }

      const topUps = JSON.parse(row.top_ups || '[]');

      if (topUps.length > 0) {
          const lastTopUp = topUps[topUps.length - 1];
          if (new Date(releaseDate) <= new Date(lastTopUp.date)) {
              return res.status(400).json({ error: 'Release Date must be after the latest Top-Up.' });
          }
      }

      const paidUps = JSON.parse(row.paid_ups || '[]');

      if (paidUps.length > 0) {
          const lastPaidUp = paidUps[paidUps.length - 1];
          if (new Date(releaseDate) <= new Date(lastPaidUp.date)) {
              return res.status(400).json({ error: 'Release Date must be after the latest Paid-Up.' });
          }
      }


      const interestHistoryResult = await pool.query(
        `SELECT interest_paid_till, interest_amount
         FROM interest_payments
         WHERE record_id = $1 AND user_id = $2
         ORDER BY interest_paid_till`,
        [row.id, req.user.id]
      );
      const interestHistory = interestHistoryResult.rows;

      const interestAlreadyPaid = interestHistory.reduce(
        (sum, item) => sum + item.interest_amount,
        0
      );

      const lastInterestPaidTill =
        interestHistory.length > 0
            ? interestHistory[interestHistory.length - 1].interest_paid_till
            : null;

      if (
          lastInterestPaidTill &&
          new Date(releaseDate) < new Date(lastInterestPaidTill)
      ) {
          return res.status(400).json({ error: 'Release Date cannot be before the latest Interest Payment.' });
      }

      let interestStartDate;

      if (lastInterestPaidTill) {
          const nextDate = new Date(lastInterestPaidTill);
          nextDate.setDate(nextDate.getDate() + 1);
          interestStartDate = nextDate.toISOString().split('T')[0];
      } else {
          interestStartDate = row.entry_date;
      }

      const remainingInterest = calculateInterestForPeriod(
          rowToRecord(row),
          interestStartDate,
          releaseDate
      );

      res.json({
        totalInterest: interestAlreadyPaid + remainingInterest,
        interestAlreadyPaid,
        remainingInterest
      });

    } catch (err) {
      next(err);
    }

  }

);


// ============================================================
// DELETE /api/customer
// ============================================================

app.delete(
    '/api/customer',

    authenticate,

    requireCsrf,

    [
        body('party').isString().trim().notEmpty().isLength({ max: 30 }).withMessage('Invalid party.'),
        body('packetNo').isInt({ min: 1, max: 1000000000 }).withMessage('Invalid packet number.')
    ],

    async (req, res, next) => {

        try {
            if (validationErrors(req, res)) return;

            const { party, packetNo } = req.body;

            const rowResult = await pool.query(
              `SELECT id FROM records
               WHERE user_id = $1 AND party = $2 AND packet_no = $3`,
              [req.user.id, party, packetNo]
            );

            const row = rowResult.rows[0];

            if (!row) {
                return res.status(404).json({ error: 'Customer not found.' });
            }

            const client = await pool.connect();
            try {
              await client.query('BEGIN');

              await client.query(
                'DELETE FROM interest_payments WHERE record_id = $1 AND user_id = $2',
                [row.id, req.user.id]
              );

              await client.query(
                'DELETE FROM records WHERE id = $1 AND user_id = $2',
                [row.id, req.user.id]
              );

              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            } finally {
              client.release();
            }

            res.json({ message: 'Customer deleted successfully.' });
        } catch (err) {
            next(err);
        }

    }
);

// ---------------------------------------------------------------------------
// Static files & error handling (unchanged)
// ---------------------------------------------------------------------------

// Global Error Handling Middleware
app.use((err, _req, res, _next) => {
  console.error('UNCAUGHT ERROR:', err);
  if (res.headersSent) {
    return _next(err);
  }
  res.status(err.status || 500).json({
    error: 'An internal server error occurred.',
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.redirect('/login.html');
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'login.html'));
});


// ---------------------------------------------------------------------------
// Start server (after schema init)
// ---------------------------------------------------------------------------

async function startServer() {
  try {
    await initSchema();

    const server = app.listen(PORT, () => {
      console.log(`Manibhadra Jewellers running at http://localhost:${PORT}`);
      if (!IS_PRODUCTION) {
        console.log(`Open http://localhost:${PORT}/login.html in your browser.`);
      }
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\nERROR: Port ${PORT} is already in use.`);
        console.error('Another copy of the server may still be running.');
        console.error('Fix: close the other terminal, or run this in PowerShell:\n');
        console.error(`  netstat -ano | findstr :${PORT}`);
        console.error('  taskkill /PID <PID_NUMBER> /F\n');
        console.error(`Or change PORT in your .env file (e.g. PORT=3001).\n`);
        process.exit(1);
      }
      throw err;
    });

    async function shutdown(signal) {
      console.log(`${signal} received. Shutting down safely...`);
      server.close(async () => {
        try {
          await pool.end();
          console.log('Database pool closed. Server shutdown complete.');
          process.exit(0);
        } catch (err) {
          console.error('Shutdown error:', err.message);
          process.exit(1);
        }
      });
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();