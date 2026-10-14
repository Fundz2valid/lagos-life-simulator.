# Lagos Life — Original 3D Life Simulator

A starter project for an original Lagos-inspired browser game. It includes:
- Three.js 3D city, walkable player character, roads, buildings and trees
- Registration and login backed by Express, SQLite, bcrypt password hashing and JWT sessions
- Server-authoritative jobs, wallet, XP, career and room rental
- Persistent player position and account progress
- Socket.IO multiplayer presence and live player movement

This is a playable starter, not a clone of any existing game. The city is a stylized prototype, and multiplayer currently synchronizes player positions only.

## Requirements

- Node.js 20 LTS or newer
- npm
- A modern browser with WebGL

## Run locally

1. Extract the project folder.
2. Open a terminal in the project folder.
3. Install packages:

   ```bash
   npm install
   ```

4. Copy `.env.example` to `.env`.
5. Change `JWT_SECRET` to a long random secret (at least 32 characters). Example generator:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   Put the output in `.env` as `JWT_SECRET=...`.

6. Start frontend and backend:

   ```bash
   npm run dev
   ```

7. Open **http://localhost:5173**. Create an account with a username, email and password (minimum 8 characters). Open the game in another browser/incognito window with another account to test multiplayer.

The backend API runs on `http://localhost:3001`. Health check: `http://localhost:3001/api/health`.

## Important configuration

`.env` is for the backend. Never commit it to Git or expose `JWT_SECRET` to the browser. SQLite data is stored in `server/lagos-life.sqlite` by default. Back up that file to back up local player accounts and progress.

For a frontend deployed on a separate domain, set `CLIENT_ORIGIN` in the backend environment to the exact frontend origin, e.g. `https://game.example.com`. Set `VITE_API_URL` at frontend build time to the backend URL. Configure HTTPS/WSS in production.

## Features and controls

- Walk with **WASD** or arrow keys. Mobile on-screen controls are included.
- Click a building to see its label.
- Work jobs to earn server-issued money and XP.
- Rent a room for ₦800.
- Use “Save progress” to persist the character position. Wallet, XP, career and home save automatically when changed.
- Player accounts and positions persist in SQLite; online positions are broadcast via Socket.IO.

## Security and production notes

This is a development starter. Before a public launch:
- Use HTTPS, secure deployment secrets, and a production database with backups.
- Add email verification, password reset, account deletion and moderation/reporting.
- Use a durable distributed rate limiter for multi-instance hosting; the sample limiter is in-memory.
- Add stricter request validation, structured logs, monitoring and automated tests.
- Use server-side collision checks and authoritative movement if you need competitive multiplayer; movement is currently client-driven with basic bounds checks.
- Consider PostgreSQL for production. SQLite is appropriate for local development and a single server instance.
- Don't store real-money balances or offer real-money cash-out without proper security, compliance and fraud controls.


## Android APK from a phone

See [ANDROID-BUILD-ON-PHONE.md](ANDROID-BUILD-ON-PHONE.md). The repository includes a GitHub Actions workflow to build a debug APK in the cloud. Deploy the backend and set the GitHub Actions variable `VITE_API_URL` to its HTTPS URL before building.
