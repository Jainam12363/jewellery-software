require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, query, validationResult } = require('express-validator');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('ERROR: Set JWT_SECRET in .env (at least 32 characters). See .env.example');
  process.exit(1);
}

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = '8h';
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const CSRF_TTL_MS = 8 * 60 * 60 * 1000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'manibhadra.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 0,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL
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
    UNIQUE(user_id, party, packet_no)
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

    FOREIGN KEY(record_id) REFERENCES records(id)

  );
`);

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

    topUps.forEach(topup => {
        principal += Number(topup.amount);
    });

    paidUps.forEach(paidup => {
        principal -= Number(paidup.amount);
    });

    return principal;
}

function calculateInterestForPeriod(record, startDate, endDate) {

    const roi = Number(record.rateOfInterest);

    let principal = Number(record.amount);

    const transactions = [];

    (record.topUps || []).forEach(topup => {
        transactions.push({
            type: 'TOPUP',
            date: topup.date,
            amount: Number(topup.amount)
        });
    });

    (record.paidUps || []).forEach(paidup => {
        transactions.push({
            type: 'PAIDUP',
            date: paidup.date,
            amount: Number(paidup.amount)
        });
    });

    transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Bring principal to the value on startDate
    for (const tx of transactions) {
        if (new Date(tx.date) < new Date(startDate)) {
            if (tx.type === 'TOPUP')
                principal += tx.amount;
            else
                principal -= tx.amount;
        }
    }

    let currentDate = startDate;
    let totalInterest = 0;

    for (const tx of transactions) {

        if (
            new Date(tx.date) < new Date(startDate) ||
            new Date(tx.date) > new Date(endDate)
        )
            continue;

        const days =
          Math.floor(
              (new Date(tx.date) - new Date(currentDate))
              / (1000 * 60 * 60 * 24)
          ) + 1;

        totalInterest +=
            (principal * roi * days) / (100 * 30);

        if (tx.type === 'TOPUP')
            principal += tx.amount;
        else
            principal -= tx.amount;

        currentDate = tx.date;
    }

    const remainingDays =
        Math.floor(
            (new Date(endDate) - new Date(currentDate))
            / (1000 * 60 * 60 * 24)
        ) + 1;

    totalInterest +=
        (principal * roi * remainingDays)
        / (100 * 30);

    return totalInterest;
}


function getReleaseSummary(record) {

    if (record.status !== 'RELEASED') {
        return null;
    }

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

    const totalInterest =
        interestAlreadyPaid + remainingInterest;

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

    if (record.status !== 'RELEASED')
        return;

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

        if (dateDiff !== 0) {
            return dateDiff;
        }

        const createdA = a.createdAt
            ? new Date(a.createdAt).getTime()
            : 0;

        const createdB = b.createdAt
            ? new Date(b.createdAt).getTime()
            : 0;

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

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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

function authenticate(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'manibhadra-jewellers' });
    const user = getUserById(payload.sub);
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

const app = express();

app.use(
  helmet({
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
app.use('/api', apiLimiter);

app.post(
  '/api/auth/register',
  [
    body('username')
      .trim()
      .isLength({ min: 3, max: 30 })
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage('Username must be 3–30 characters (letters, numbers, underscore only).'),
    body('email').trim().isEmail().normalizeEmail().withMessage('Enter a valid email address.'),
    body('password')
      .isLength({ min: 8, max: 128 })
      .matches(PASSWORD_REGEX)
      .withMessage(
        'Password must be 8–128 characters with uppercase, lowercase, number, and special character.'
      ),
    body('confirmPassword').custom((value, { req }) => {
      if (value !== req.body.password) throw new Error('Passwords do not match.');
      return true;
    }),
  ],
  async (req, res) => {
    if (validationErrors(req, res)) return;

    const { username, email, password } = req.body;

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? OR email = ? COLLATE NOCASE')
      .get(username, email);
    if (existing) {
      return res.status(409).json({ error: 'Username or email is already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, username, email, passwordHash, createdAt);

    res.status(201).json({ message: 'Account created successfully. You can now log in.' });
  }
);

app.post(
  '/api/auth/login',
  [
    body('identifier').trim().notEmpty().withMessage('Username or email is required.'),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  async (req, res) => {
    if (validationErrors(req, res)) return;

    const identifier = req.body.identifier.trim();
    const password = req.body.password;

    const user = db.prepare(`
      SELECT *
      FROM users
      WHERE username = ? COLLATE NOCASE
        OR email = ? COLLATE NOCASE
    `).get(identifier, identifier);


    if (!user) {
      await bcrypt.hash(password, BCRYPT_ROUNDS);
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
      let lockedUntil = null;
      if (attempts >= LOCKOUT_ATTEMPTS) {
        lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
      }
      db.prepare(
        `UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?`
      ).run(attempts, lockedUntil, user.id);

      if (lockedUntil) {
        return res.status(429).json({
          error: 'Too many failed attempts. Account locked for 15 minutes.',
        });
      }
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    db.prepare(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`
    ).run(user.id);

    revokeCsrfTokensForUser(user.id);
    const token = signToken(user);
    const csrfToken = createCsrfToken(user.id);
    setAuthCookie(res, token);

    res.json({
      user: { username: user.username, email: user.email },
      csrfToken,
    });
  }
);

app.post('/api/auth/logout', authenticate, requireCsrf, (req, res) => {
  const user = getUserById(req.user.id);
  if (user) {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);
    revokeCsrfTokensForUser(user.id);
  }
  clearAuthCookie(res);
  res.json({ message: 'Logged out successfully.' });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  const csrfToken = createCsrfToken(req.user.id);
  res.json({
    user: { username: req.user.username, email: req.user.email },
    csrfToken,
  });
});


// ============================================================
// REPORTS - EXISTING CUSTOMERS
// ============================================================

app.get(
  '/api/reports/existing-customers',
  authenticate,
  [
    query('party').trim().notEmpty(),
    query('date').isISO8601({ strict: false })
  ],
  (req, res) => {

    if (validationErrors(req, res)) return;

    const { party, date } = req.query;

    try {

      /*
       * Get all customers belonging to the logged-in user
       * and selected party.
       */
      const rows = db.prepare(`
        SELECT *
        FROM records
        WHERE user_id = ?
          AND party = ?
        ORDER BY packet_no
      `).all(
        req.user.id,
        party
      );


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
        if (
          new Date(record.entryDate) > new Date(date)
        ) {
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
         *
         * Start with the original principal and apply only
         * transactions that happened on/before the report date.
         */

        let currentPrincipal =
          Number(record.amount);


        const topUpsTillDate =
          (record.topUps || []).filter(
            topup =>
              new Date(topup.date) <= new Date(date)
          );


        const paidUpsTillDate =
          (record.paidUps || []).filter(
            paidup =>
              new Date(paidup.date) <= new Date(date)
          );


        topUpsTillDate.forEach(topup => {

          currentPrincipal +=
            Number(topup.amount);

        });


        paidUpsTillDate.forEach(paidup => {

          currentPrincipal -=
            Number(paidup.amount);

        });


        /*
         * ----------------------------------------------------
         * Interest Payments Till Report Date
         * ----------------------------------------------------
         */

        const interestPayments =
          db.prepare(`
            SELECT
              payment_date,
              interest_paid_till,
              interest_amount
            FROM interest_payments
            WHERE record_id = ?
              AND interest_paid_till <= ?
            ORDER BY interest_paid_till
          `).all(
            row.id,
            date
          );


        const interestPaid =
          interestPayments.reduce(
            (sum, payment) =>
              sum + Number(payment.interest_amount),
            0
          );


        /*
         * ----------------------------------------------------
         * Interest Accrued Till Report Date
         * ----------------------------------------------------
         *
         * Reuse the application's existing interest
         * calculation so the report follows the same
         * calculation rules as the rest of the application.
         */

        const interestAccrued =
          calculateInterestForPeriod(
            {
              ...record,
              topUps: topUpsTillDate,
              paidUps: paidUpsTillDate
            },
            record.entryDate,
            date
          );


        /*
         * Interest that has accrued but has not yet
         * been paid.
         */

        const pendingInterest =
          Math.max(
            0,
            interestAccrued - interestPaid
          );


        /*
         * Total amount recoverable as of the
         * selected report date.
         */

        const totalRecoverable =
          currentPrincipal + pendingInterest;


        reportRecords.push({

          packetNo: record.packetNo,

          customerName: record.customerName,

          phoneNumber: record.phoneNumber,

          entryDate: record.entryDate,

          initialPrincipal:
            Number(record.amount),

          currentPrincipal,

          rateOfInterest:
            Number(record.rateOfInterest),

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

        totalCustomers:
          reportRecords.length,

        totalInitialPrincipal:
          reportRecords.reduce(
            (sum, customer) =>
              sum + customer.initialPrincipal,
            0
          ),

        totalCurrentPrincipal:
          reportRecords.reduce(
            (sum, customer) =>
              sum + customer.currentPrincipal,
            0
          ),

        totalInterestAccrued:
          reportRecords.reduce(
            (sum, customer) =>
              sum + customer.interestAccrued,
            0
          ),

        totalInterestPaid:
          reportRecords.reduce(
            (sum, customer) =>
              sum + customer.interestPaid,
            0
          ),

        totalPendingInterest:
          reportRecords.reduce(
            (sum, customer) =>
              sum + customer.pendingInterest,
            0
          ),

        totalRecoverable:
          reportRecords.reduce(
            (sum, customer) =>
              sum + customer.totalRecoverable,
            0
          )

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

      console.error(
        'Existing customers report error:',
        err
      );

      res.status(500).json({

        error:
          'Failed to generate existing customers report.'

      });

    }

  }
);

app.get(
  '/api/records',
  authenticate,
  [
    query('party').optional().trim(),
    query('packetNo').optional().isInt({ min: 1 }),
    query('name').optional().trim(),
  ],
  (req, res) => {
    if (validationErrors(req, res)) return;

    const { party, packetNo, name } = req.query;
    let rows = db.prepare(
      'SELECT * FROM records WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);

    if (party) rows = rows.filter((r) => r.party === party);
    if (packetNo) rows = rows.filter((r) => r.packet_no === Number(packetNo));
    if (name) {
      const q = name.toLowerCase();
      rows = rows.filter((r) => r.customer_name.toLowerCase().includes(q));
    }

    const records = rows.map(row => {

        const record = rowToRecord(row);

        record.interestPayments = db.prepare(`
            SELECT
                payment_date,
                interest_paid_till,
                interest_amount
            FROM interest_payments
            WHERE record_id = ?
            ORDER BY payment_date
        `).all(row.id).map(item => ({

            date: item.payment_date,

            interestPaidTill: item.interest_paid_till,

            amount: item.interest_amount

        }));

        record.hasTransactions =
            record.topUps.length > 0 ||
            record.paidUps.length > 0 ||
            record.interestPayments.length > 0;

        return record;

    });

    res.json({
        records
    });
  }
);


app.get('/api/ledger', authenticate, (req, res) => {

    try {

        const { packetNo, name, party } = req.query;

        let row = null;

        if (packetNo) {

            row = db.prepare(`
                SELECT *
                FROM records
                WHERE user_id = ?
                  AND party = ?
                  AND packet_no = ?
            `).get(
                req.user.id,
                party,
                packetNo
            );

        }
        else if (name) {

            const rows = db.prepare(`
                SELECT *
                FROM records
                WHERE user_id = ?
                  AND party = ?
                  AND customer_name LIKE ?
                ORDER BY customer_name
            `).all(
                req.user.id,
                party,
                `%${name}%`
            );

            return res.json({
                records: rows.map(rowToRecord)
            });

        }
        else {

            return res.status(400).json({
                error: 'Packet Number or Customer Name is required.'
            });

        }

        if (!row) {

            return res.status(404).json({
                error: 'Customer not found.'
            });

        }

        const record = rowToRecord(row);

        // Interest Payment History
        record.interestPayments = db.prepare(`
            SELECT
                payment_date,
                interest_paid_till,
                interest_amount,
                created_at
            FROM interest_payments
            WHERE record_id = ?
            ORDER BY payment_date
        `).all(row.id).map(payment => ({

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

        res.json({

            record,

            summary,

            timeline

        });

    }

    catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });

    }

});

app.post(
  '/api/records',
  authenticate,
  requireCsrf,
  [
    body('party').trim().notEmpty(),
    body('packetNo').isInt({ min: 1 }),
    body('customerName').trim().isLength({ min: 1, max: 100 }),
    body('phoneNumber')
      .trim()
      .matches(/^[0-9]{10}$/)
      .withMessage('Phone number must be exactly 10 digits.'),

    body('item')
      .isIn(['Gold', 'Silver', 'Both'])
      .withMessage('Invalid item.'),
    body('itemName').trim().isLength({ min: 1, max: 100 }),
    body('amount').isFloat({ min: 0 }),
    body('quantity').isInt({ min: 1 }),
    body('weight').isFloat({ min: 0 }),
    body('entryDate').isISO8601({ strict: false }),
    body('rateOfInterest').isFloat({ min: 0 }),
  ],
  (req, res) => {
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

    const existing = db
      .prepare(
        'SELECT id FROM records WHERE user_id = ? AND party = ? AND packet_no = ?'
      )
      .get(req.user.id, party, packetNo);
    if (existing) {
      return res.status(409).json({ error: `Packet ${packetNo} already exists for ${party}.` });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO records (
        id,
        user_id,
        party,
        packet_no,
        customer_name,
        phone_number,
        item,
        item_name,
        amount,
        quantity,
        weight,
        entry_date,
        release_date,
        status,
        rate_of_interest,
        top_ups,
        paid_ups,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
    );

    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    res.status(201).json({ record: rowToRecord(row) });
  }
);

app.post(
  '/api/records/topup',
  authenticate,
  requireCsrf,
  [
    body('party').trim().notEmpty(),
    body('packetNo').isInt({ min: 1 }),
    body('amount').isFloat({ min: 0.01 }),
    body('date').isISO8601({ strict: false }),
  ],
  (req, res) => {
    if (validationErrors(req, res)) return;

    const { party, packetNo, amount, date } = req.body;
    const row = db
      .prepare(
        'SELECT * FROM records WHERE user_id = ? AND party = ? AND packet_no = ?'
      )
      .get(req.user.id, party, packetNo);



    if (!row) {

        return res.status(404).json({

            error: `No record found for Packet ${packetNo} under ${party}.`

        });

    }

    if (row.status === 'RELEASED') {

        return res.status(400).json({

            error: 'Customer has already been released. Top-Up is not allowed.'

        });

    }

    if (new Date(date) <= new Date(row.entry_date)) {
      return res.status(400).json({ error: 'Top-up date must be after the entry date.' });
    }
    if (
        row.release_date &&
        new Date(date) >= new Date(row.release_date)
    ) {
        return res.status(400).json({
            error: 'Top-up date must be before the release date.'
        });
    }

    const topUps = JSON.parse(row.top_ups || '[]');
    topUps.push({
        date,
        amount: Number(amount),
        createdAt: new Date().toISOString()
    });
    topUps.sort(

        (a, b) =>

            new Date(a.date) -

            new Date(b.date)

    );
    db.prepare('UPDATE records SET top_ups = ? WHERE id = ?').run(JSON.stringify(topUps), row.id);

    const updated = db.prepare('SELECT * FROM records WHERE id = ?').get(row.id);
    res.json({ record: rowToRecord(updated) });
  }
);



// paid up logic

app.post(
  '/api/records/paidup',
  authenticate,
  requireCsrf,
  [
    body('party').trim().notEmpty(),
    body('packetNo').isInt({ min: 1 }),
    body('amount').isFloat({ min: 0.01 }),
    body('date').isISO8601({ strict: false }),
  ],
  (req, res) => {
    if (validationErrors(req, res)) return;

    const { party, packetNo, amount, date } = req.body;
    const row = db
      .prepare(
        'SELECT * FROM records WHERE user_id = ? AND party = ? AND packet_no = ?'
      )
      .get(req.user.id, party, packetNo);



    if (!row) {

        return res.status(404).json({

            error: `No record found for Packet ${packetNo} under ${party}.`

        });

    }

    if (row.status === 'RELEASED') {

        return res.status(400).json({

            error: 'Customer has already been released. Paid-Up is not allowed.'

        });

    }

    if (new Date(date) <= new Date(row.entry_date)) {
      return res.status(400).json({ error: 'Paid-Up date must be after the entry date.' });
    }
    if (
        row.release_date &&
        new Date(date) >= new Date(row.release_date)
    ) {
        return res.status(400).json({
            error: 'Paid-Up date must be before the release date.'
        });
    }

    const paidUps = JSON.parse(row.paid_ups || '[]');
    paidUps.push({
        date,
        amount: Number(amount),
        createdAt: new Date().toISOString()
    });
    paidUps.sort(

        (a, b) =>

            new Date(a.date) -

            new Date(b.date)

    );

    db.prepare(
        'UPDATE records SET paid_ups = ? WHERE id = ?'
    ).run(
        JSON.stringify(paidUps),
        row.id
    );

    const updated = db.prepare('SELECT * FROM records WHERE id = ?').get(row.id);
    res.json({ record: rowToRecord(updated) });
  }
);


app.put(
  '/api/records/edit',
  authenticate,
  requireCsrf,
  [
    body('party').trim().notEmpty(),
    body('packetNo').isInt({ min: 1 }),

    body('customerName').trim().isLength({ min: 1, max: 100 }),

    body('phoneNumber')
      .trim()
      .matches(/^[0-9]{10}$/)
      .withMessage('Phone number must be exactly 10 digits.'),

    body('item')
      .isIn(['Gold', 'Silver', 'Both'])
      .withMessage('Invalid item.'),

    body('itemName').trim().isLength({ min: 1, max: 100 }),

    body('amount').isFloat({ min: 0 }),

    body('quantity').isInt({ min: 1 }),

    body('weight').isFloat({ min: 0 }),

    body('entryDate').isISO8601({ strict: false }),

    body('rateOfInterest').isFloat({ min: 0 }),
  ],

  (req, res) => {

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

    const row = db.prepare(
      `SELECT *
       FROM records
       WHERE user_id = ?
       AND party = ?
       AND packet_no = ?`
    ).get(req.user.id, party, packetNo);

    if (!row) {
      return res.status(404).json({
        error: 'Customer not found.'
      });
    }

    const hasTransactions =
        JSON.parse(row.top_ups || "[]").length > 0 ||
        JSON.parse(row.paid_ups || "[]").length > 0 ||
        db.prepare(`
            SELECT COUNT(*)
            AS count
            FROM interest_payments
            WHERE record_id = ?
        `).get(row.id).count > 0;

    if (hasTransactions) {

        db.prepare(`
            UPDATE records
            SET
                customer_name = ?,
                phone_number = ?,
                item = ?,
                item_name = ?,
                quantity = ?,
                weight = ?,
                entry_date = ?
            WHERE id = ?
        `).run(
            customerName,
            phoneNumber,
            item,
            itemName,
            quantity,
            weight,
            entryDate,
            row.id
        );

    } else {

        db.prepare(`
            UPDATE records
            SET
                customer_name = ?,
                phone_number = ?,
                item = ?,
                item_name = ?,
                amount = ?,
                quantity = ?,
                weight = ?,
                entry_date = ?,
                rate_of_interest = ?
            WHERE id = ?
        `).run(
            customerName,
            phoneNumber,
            item,
            itemName,
            amount,
            quantity,
            weight,
            entryDate,
            rateOfInterest,
            row.id
        );

    }

    const updated = db.prepare(
      'SELECT * FROM records WHERE id = ?'
    ).get(row.id);

    res.json({
      record: rowToRecord(updated)
    });

  }
);


app.put(
  '/api/records/release',
  authenticate,
  requireCsrf,
  [
    body('party').trim().notEmpty(),
    body('packetNo').isInt({ min: 1 }),
    body('releaseDate').isISO8601({ strict: false }),
  ],

  (req, res) => {

    if (validationErrors(req, res)) return;

    const {
      party,
      packetNo,
      releaseDate
    } = req.body;

    const row = db.prepare(
      `SELECT *
      FROM records
      WHERE user_id = ?
      AND party = ?
      AND packet_no = ?`
    ).get(
      req.user.id,
      party,
      packetNo
    );

    if (!row) {
      return res.status(404).json({
        error: 'Customer not found.'
      });
    }

    const interestHistory = db.prepare(`
        SELECT
            interest_paid_till,
            interest_amount
        FROM interest_payments
        WHERE record_id = ?
        ORDER BY interest_paid_till
    `).all(row.id);

    const interestAlreadyPaid = interestHistory.reduce(
      (sum, item) => sum + item.interest_amount,
      0
    );

    const lastInterestPaidTill =
      interestHistory.length > 0
        ? interestHistory[interestHistory.length - 1].interest_paid_till
        : null;


    if (row.status === 'RELEASED') {
      return res.status(400).json({
        error: 'Customer is already released.'
      });
    }

    if (new Date(releaseDate) <= new Date(row.entry_date)) {
      return res.status(400).json({
        error: 'Release Date must be after Entry Date.'
      });
    }


    const topUps = JSON.parse(row.top_ups || "[]");

    if (topUps.length > 0) {

        const lastTopUp = topUps[topUps.length - 1];

        if (new Date(releaseDate) <= new Date(lastTopUp.date)) {

            return res.status(400).json({
                error: "Release Date must be after the latest Top-Up."
            });

        }

    }

    const paidUps = JSON.parse(row.paid_ups || "[]");

    if (paidUps.length > 0) {

        const lastPaidUp = paidUps[paidUps.length - 1];

        if (new Date(releaseDate) <= new Date(lastPaidUp.date)) {

            return res.status(400).json({
                error: "Release Date must be after the latest Paid-Up."
            });

        }

    }

    if (
        lastInterestPaidTill &&
        new Date(releaseDate) < new Date(lastInterestPaidTill)
    ) {
        return res.status(400).json({
            error: "Release Date cannot be before the latest Interest Payment."
        });
    }


    let interestStartDate;

    if (lastInterestPaidTill) {
        const nextDate = new Date(lastInterestPaidTill);
        nextDate.setDate(nextDate.getDate() + 1);
        interestStartDate = nextDate.toISOString().split('T')[0];
    } else {
        interestStartDate = row.entry_date;
    }

    const remainingInterest =
      calculateInterestForPeriod(
          rowToRecord(row),
          interestStartDate,
          releaseDate
      );

    const totalInterest =
      interestAlreadyPaid +
      remainingInterest;

    db.prepare(`
      UPDATE records
      SET
        release_date = ?,
        status = 'RELEASED'
      WHERE id = ?
    `).run(
      releaseDate,
      row.id
    );

    const updated = db.prepare(
      'SELECT * FROM records WHERE id = ?'
    ).get(row.id);

    res.json({

      record: rowToRecord(updated),

      totalInterest,

      interestAlreadyPaid,

      remainingInterest

    });

  }
);


app.get(
  '/api/interest-payment/search',
  authenticate,
  [
    query('party').trim().notEmpty(),
    query('packetNo').isInt({ min: 1 })
  ],

  (req, res) => {

    if (validationErrors(req, res)) return;

    const { party, packetNo } = req.query;

    const record = db.prepare(`
      SELECT *
      FROM records
      WHERE user_id = ?
      AND party = ?
      AND packet_no = ?
    `).get(
      req.user.id,
      party,
      Number(packetNo)
    );

    if (!record) {
      return res.status(404).json({
        error: 'Customer not found.'
      });
    }

    const history = db.prepare(`
      SELECT

        interest_start_date,

        interest_paid_till,

        interest_amount,

        payment_date
      FROM interest_payments
      WHERE record_id = ?
      ORDER BY interest_paid_till
    `).all(record.id);

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

  }
);


app.post(
  '/api/interest-payment',

  authenticate,

  requireCsrf,

  [

    body('recordId').trim().notEmpty(),

    body('interestStartDate').isISO8601({ strict: false }),

    body('interestPaidTill').isISO8601({ strict: false })

  ],

  (req, res) => {

    if (validationErrors(req, res)) return;

    const {

      recordId,

      interestStartDate,

      interestPaidTill

    } = req.body;

    const record = db.prepare(

      `SELECT *
       FROM records
       WHERE id = ?
       AND user_id = ?`

    ).get(

      recordId,

      req.user.id

    );

    if (!record) {

      return res.status(404).json({

        error: 'Customer not found.'

      });

    }


    if (record.status === 'RELEASED') {

      return res.status(400).json({

        error: 'Interest payment cannot be added. Customer has already been released.'

      });

    }


    const lastPayment = db.prepare(`
        SELECT
            interest_start_date,
            interest_paid_till
        FROM interest_payments
        WHERE record_id = ?
        ORDER BY interest_paid_till DESC
        LIMIT 1
    `).get(recordId);


    const numberOfDays =

      Math.floor(

        (

          new Date(interestPaidTill) -

          new Date(interestStartDate)

        ) / (1000 * 60 * 60 * 24)

      ) + 1;

    let expectedStartDate;

    if (lastPayment) {

        const nextDate = new Date(lastPayment.interest_paid_till);

        nextDate.setDate(nextDate.getDate() + 1);

        expectedStartDate =
            nextDate.toISOString().split('T')[0];

    }
    else {

        expectedStartDate =
            record.entry_date;

    }

    if (interestStartDate !== expectedStartDate) {

        return res.status(400).json({

            error:
                `Interest Start Date must be ${expectedStartDate}.`

        });

    }

    if (new Date(interestPaidTill) <= new Date(interestStartDate)) {

      return res.status(400).json({

        error:
          'Interest Paid Till date must be after Interest Start Date.'

      });

    }


    const duplicate = db.prepare(`
        SELECT id
        FROM interest_payments
        WHERE record_id = ?
        AND interest_paid_till = ?
    `).get(
      recordId,
      interestPaidTill
    );

    if (duplicate) {

      return res.status(409).json({

        error: 'Interest for this period has already been recorded.'

      });

    }



    const calculatedInterest =
      calculateInterestForPeriod(
          rowToRecord(record),
          interestStartDate,
          interestPaidTill
      );



    const id = crypto.randomUUID();

    const today = new Date().toISOString().split('T')[0];

    const createdAt = new Date().toISOString();

    db.prepare(

      `INSERT INTO interest_payments(

        id,

        user_id,

        record_id,

        interest_start_date,

        interest_paid_till,

        interest_amount,

        payment_date,

        created_at

      )

      VALUES(?,?,?,?,?,?,?,?)`

    ).run(

      id,

      req.user.id,

      recordId,

      interestStartDate,

      interestPaidTill,

      calculatedInterest,

      today,

      createdAt

    );

    res.json({

      message: 'Interest payment saved successfully.',

      interestAmount: calculatedInterest,

      numberOfDays,

      interestStartDate,

      interestPaidTill

    });

  }

);

app.post(
  '/api/records/release-preview',

  authenticate,

  requireCsrf,

  [

    body('party').trim().notEmpty(),

    body('packetNo').isInt({ min: 1 }),

    body('releaseDate').isISO8601({ strict: false })

  ],

  (req, res) => {

    if (validationErrors(req, res)) return;

    const {

      party,

      packetNo,

      releaseDate

    } = req.body;

    const row = db.prepare(

      `SELECT *
           FROM records
           WHERE user_id = ?
           AND party = ?
           AND packet_no = ?`

    ).get(

      req.user.id,

      party,

      packetNo

    );

    if (!row) {

      return res.status(404).json({

        error: 'Customer not found.'

      });

    }

    const topUps = JSON.parse(row.top_ups || "[]");

    if (topUps.length > 0) {

        const lastTopUp = topUps[topUps.length - 1];

        if (new Date(releaseDate) <= new Date(lastTopUp.date)) {

            return res.status(400).json({
                error: "Release Date must be after the latest Top-Up."
            });

        }

    }

    const paidUps = JSON.parse(row.paid_ups || "[]");

    if (paidUps.length > 0) {

        const lastPaidUp = paidUps[paidUps.length - 1];

        if (new Date(releaseDate) <= new Date(lastPaidUp.date)) {

            return res.status(400).json({
                error: "Release Date must be after the latest Paid-Up."
            });

        }

    }


    const interestHistory = db.prepare(

      `SELECT
              interest_paid_till,
              interest_amount
           FROM interest_payments
           WHERE record_id = ?
           ORDER BY interest_paid_till`

    ).all(row.id);

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
        return res.status(400).json({
            error: "Release Date cannot be before the latest Interest Payment."
        });
    }

    let interestStartDate;

    if (lastInterestPaidTill) {
        const nextDate = new Date(lastInterestPaidTill);
        nextDate.setDate(nextDate.getDate() + 1);
        interestStartDate = nextDate.toISOString().split('T')[0];
    } else {
        interestStartDate = row.entry_date;
    }


    const remainingInterest =
      calculateInterestForPeriod(
          rowToRecord(row),
          interestStartDate,
          releaseDate
      );

    res.json({

      totalInterest:

        interestAlreadyPaid +

        remainingInterest,

      interestAlreadyPaid,

      remainingInterest

    });

  }

);


app.delete(
    "/api/customer",

    authenticate,

    requireCsrf,

    [
        body("party").trim().notEmpty(),

        body("packetNo").isInt({ min: 1 })
    ],

    (req, res) => {

        if (validationErrors(req, res))
            return;

        const { party, packetNo } = req.body;

        const row = db.prepare(`
            SELECT id
            FROM records
            WHERE user_id = ?
              AND party = ?
              AND packet_no = ?
        `).get(
            req.user.id,
            party,
            packetNo
        );

        if (!row) {

            return res.status(404).json({
                error: "Customer not found."
            });

        }

        const deleteCustomer = db.transaction((recordId) => {

            db.prepare(`
                DELETE FROM interest_payments
                WHERE record_id = ?
            `).run(recordId);

            db.prepare(`
                DELETE FROM records
                WHERE id = ?
            `).run(recordId);

        });

        deleteCustomer(row.id);

        res.json({
            message: "Customer deleted successfully."
        });

    }
);


app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.redirect('/login.html');
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'login.html'));
});



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