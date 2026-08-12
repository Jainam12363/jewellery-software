# Manibhadra Jewellers

Web-based management system for customer and jewellery pledge records, with secure login.

## Features

- **Login & Register** — Staff accounts with secure password storage
- **Add Customer** — Save pledge records with interest calculation
- **Search** — Find records by packet number and/or customer name
- **Top-Up** — Mid-term loan additions with split interest periods
- **Interest Detail** — Step-by-step interest breakdown

## Security

- Passwords hashed with **bcrypt** (never stored in plain text)
- Sessions use **httpOnly cookies** (not accessible to JavaScript)
- **CSRF protection** on all write operations
- **Rate limiting** on login/register and API
- **Account lockout** after 5 failed login attempts (15 minutes)
- Strong password rules (uppercase, lowercase, number, special character)
- Security headers via **Helmet**

## How to Run

### 1. Install Node.js

Download from [nodejs.org](https://nodejs.org) if you don't have it (version 18+).

### 2. Open the project folder in terminal

```powershell
cd "D:\Jewellery software"
```

### 3. Install dependencies

```powershell
npm install
```

### 4. Set up environment

Copy `.env.example` to `.env` and change `JWT_SECRET` to a long random string:

```powershell
copy .env.example .env
```

### 5. Start the server

```powershell
npm start
```

### 6. Open in browser

Go to: **http://localhost:3000/login.html**

1. Click **Create one** to register a staff account
2. Sign in with your username and password
3. Use the app as before

> **Important:** Do not open `index.html` directly by double-clicking anymore. Always use the server at `http://localhost:3000` so login and security work correctly.

## Password requirements

- At least 8 characters
- One uppercase letter, one lowercase letter, one number, one special character

Example: `Manibhadra@2026`

## Project structure

```
server.js          — Backend API and authentication
public/
  login.html       — Sign in page
  register.html    — Create account page
  index.html       — Main app (requires login)
  app.js           — Frontend logic
  auth.js          — Auth helpers
  styles.css       — Styling
data/              — SQLite database (created automatically)
```

## Interest formula

```
Interest = (Amount × Days × ROI) / (30 × 100)
```

Top-ups split the calculation into separate date periods.
