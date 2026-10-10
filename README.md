# Manibhadra Jewellers

A web-based jewellery loan management system for managing customers, pledged jewellery records, loan amounts, interest payments, top-ups, paid-up transactions, releases, and customer ledgers. The application includes secure staff authentication and automated password-reset emails.

## Features

### Customer & Loan Management
- **Staff Authentication** — Secure login and registration.
- **Add Customer** — Create customer records and jewellery pledge details.
- **Edit Customer** — Update customer and loan information when permitted.
- **Search Customers** — Find records using packet numbers and/or customer names.
- **Interest Calculation** — Calculate interest based on principal, rate of interest (ROI), and the number of days.
- **Interest Payment** — Record interest payments and update the relevant payment details.
- **Top-Up** — Record additional loan amounts and calculate interest across separate periods.
- **Paid-Up** — Record loan repayment transactions.
- **Release** — Record the release of pledged jewellery after loan settlement.
- **Customer Ledger** — Search customer transaction history and view or generate ledger reports.
- **Reports** — View existing and released customer records, including relevant loan and transaction information.

### Account & Password Management
- Secure login and staff registration.
- Forgot-password functionality using email-based password reset.
- Password reset emails sent through Brevo.
- Session-based access protection for application pages and APIs.

## Technology Stack

| Component | Technology / Service |
|---|---|
| Backend | Node.js and Express.js |
| Frontend | HTML, CSS, JavaScript |
| Database | Neon — hosted database |
| Authentication | bcrypt-based password hashing and secure sessions |
| Email delivery | Brevo Transactional Email API |
| Hosting and deployment | Render |
| Source code and version control | Git and GitHub |
| Package management | npm |

## External Websites & Services

The following websites and services support the application.

| Website / Service | Purpose | Link |
|---|---|---|
| **GitHub** | Stores the project's source code, tracks changes through Git, and maintains the repository. | https://github.com |
| **Render** | Hosts the application so it can be accessed online. It also supports deployments from the GitHub repository. | https://render.com |
| **Neon** | Provides the hosted database used to store application data. Database connectivity is configured through environment variables. | https://neon.tech |
| **Brevo** | Sends transactional emails, particularly forgot-password and password-reset emails. The application uses the Brevo API and a configured sender email address. | https://www.brevo.com |
| **Node.js** | Provides the JavaScript runtime required to run the backend locally and on the hosting platform. | https://nodejs.org |
| **npm** | Installs and manages the application's Node.js dependencies. | https://www.npmjs.com |

### How the Services Work Together

1. The source code is maintained in **GitHub**.
2. **Render** deploys and runs the application.
3. The application connects to **Neon** to access its hosted database.
4. When a user requests a password reset, the backend uses **Brevo** to send the email.
5. **Node.js** runs the backend, while **npm** manages its dependencies.

## Security

The application includes the following security measures:

- **Password hashing:** Passwords are hashed using bcrypt rather than stored in plain text.
- **Secure sessions:** Session cookies use the `httpOnly` attribute to prevent direct access from client-side JavaScript.
- **CSRF protection:** Protection is applied to write operations.
- **Rate limiting:** Limits requests to authentication endpoints and APIs.
- **Account lockout:** Locks an account after five failed login attempts for 15 minutes.
- **Password policy:** Requires uppercase and lowercase letters, a number, a special character, and at least eight characters.
- **Security headers:** Uses Helmet to configure HTTP security headers.
- **Environment-based configuration:** Secrets, API keys, and connection settings are configured through environment variables rather than committed to the repository.

> Never commit `.env` files, database credentials, API keys, session secrets, or other sensitive configuration to GitHub.

## Getting Started — Local Setup

### Prerequisites

Install the following:

- [Node.js](https://nodejs.org/) — version 18 or later, subject to the version required by the project.
- Git (optional, if cloning the repository).
- Access to the configured Neon database, if the application requires it for local operation.
- A Brevo API key and verified sender email address for password-reset email functionality.

### 1. Clone the Repository

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd "Jewellery software"
```

Replace the placeholder with your actual GitHub repository URL. If the project is already on your computer, open its existing project directory instead.

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a local `.env` file using the project's `.env.example` as a reference:

```bash
copy .env.example .env
```

On Windows PowerShell, you can use:

```powershell
Copy-Item .env.example .env
```

Configure the required values according to the application's current environment-variable names. These may include:

- Database connection URL for Neon.
- A strong, randomly generated session or authentication secret.
- `BREVO_API_KEY` for transactional email delivery.
- `SMTP_FROM` for the configured sender email address.

Use the exact variable names expected by the backend. Do not paste real credentials into this README or commit them to GitHub.

### 4. Start the Application

```bash
npm start
```

### 5. Open the Application

For local development, open:

```text
http://localhost:3000/login.html
```

Register a staff account if registration is enabled, sign in, and use the application.

> **Important:** Do not open `public/index.html` directly by double-clicking it. Run the backend server and access the application through its HTTP URL so that authentication, API requests, and session handling work correctly.

## Deployment

The production application is hosted on Render.

A typical deployment workflow is:

1. Make and test changes locally.
2. Review the changes using Git.
3. Commit the changes.
4. Push the commits to the configured GitHub branch.
5. Allow Render to deploy the updated application, according to its deployment settings.
6. Verify that the application, database connectivity, login, and password-reset functionality work correctly.

### Production Configuration

Configure environment variables in Render's service settings rather than committing production credentials to the repository.

Verify the following when setting up or troubleshooting the deployment:

- The correct database connection is configured.
- Authentication and session secrets are present.
- The Brevo API key is configured.
- The sender email address is verified and configured.
- The application is listening on the port supplied by the hosting environment.
- Database schema changes and migrations, if applicable, have been applied.

## Password Requirements

Passwords must meet the application's password policy:

- At least 8 characters.
- At least one uppercase letter.
- At least one lowercase letter.
- At least one number.
- At least one special character.

Example format: `Example@2026`

Use a unique password for each account. The example above is illustrative and should not be used as a real password.

## Interest Calculation

The basic interest formula is:

```text
Interest = (Principal × Number of Days × ROI) / (30 × 100)
```

Where:

- **Principal:** Loan amount on which interest is calculated.
- **Number of Days:** Duration of the interest period.
- **ROI:** Rate of interest expressed as a percentage.

Top-ups can divide the calculation into separate periods so that interest is calculated against the applicable principal and dates for each period.

## Project Structure

The following is a simplified overview of the project:

```text
Jewellery software/
├── server.js
├── package.json
├── package-lock.json
├── .env.example
├── public/
│   ├── login.html
│   ├── register.html
│   ├── index.html
│   ├── app.js
│   ├── auth.js
│   └── styles.css
└── ...
```

The exact structure may include additional backend modules, database-related files, authentication pages, and supporting assets.

## Troubleshooting

**Application does not start**
- Confirm that Node.js is installed.
- Run `npm install`.
- Check the terminal output for errors.
- Verify that required environment variables are configured.

**Database connection fails**
- Verify the Neon connection URL and database credentials.
- Check the database's availability and connection settings.
- Confirm that the backend is using the expected database configuration.

**Password-reset email is not received**
- Verify `BREVO_API_KEY`.
- Confirm that `SMTP_FROM` matches a verified sender configured in Brevo.
- Check the backend logs and Brevo's email delivery activity.
- Check the recipient's spam folder.

**Changes do not appear online**
- Confirm that the changes were committed and pushed to the correct GitHub branch.
- Check the latest deployment status in Render.
- Refresh the application after deployment completes.

## License

Add the applicable license information here if the project is intended to be distributed or reused.
