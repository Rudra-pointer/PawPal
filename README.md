# PawPal

PawPal is a pet adoption platform for adopters, shelters, and administrators. It uses React 18 and Vite for the client, Express for the API, and PostgreSQL through parameterized `pg` queries. The reference UI is in `docs/frontend-reference/PawPal_Premium.html` and is preserved as the visual source of truth.

## Local setup (about 10 minutes)

1. Install Node.js 20+ and PostgreSQL 13+.
2. Create the local `pawpal` and `pawpal_test` databases and the `pawpal_app` role using the SQL in `docs/db/` or your existing PostgreSQL setup.
3. Copy `.env.example` to `.env`. Set the local database URLs, a unique random `JWT_SECRET` of at least 32 characters, and a private `SEED_PASSWORD`. Never commit `.env`.
4. Install workspace dependencies with `npm ci`.
5. Apply migrations with `npm run migrate` (uses `DATABASE_URL`).
6. For an intentionally empty development database, optionally run `npm run seed`; this is idempotent and refuses to run in production without `--force`.
7. Start both services with `npm run dev` and `npm run dev --workspace=client` in separate terminals. The API is at `http://localhost:5000`; Vite is at `http://localhost:5173`.
8. Verify with `npm run verify`.

Automated tests and the smoke test require `TEST_DATABASE_URL` to point to a database whose actual name is `pawpal_test`. The application refuses to start its test pool if the URL names another database.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch and run the Express API |
| `npm run dev --workspace=client` | Run Vite with `/api` proxied to Express |
| `npm run migrate` | Apply additive development migrations |
| `npm run migrate:test` | Apply migrations to the test database using the migration runner's test flag |
| `npm run seed` | Insert the intended demo dataset; never run this against production |
| `npm test` | Run Vitest and Supertest against `pawpal_test` |
| `npm run lint` | Run built-in Node syntax and source safety checks without extra packages |
| `npm run build` | Create the production client bundle in `client/dist` |
| `npm run smoke` | Exercise the complete adoption/admin story with temporary `pawpal_test` fixtures |
| `npm run verify` | Lint, tests, production client build, then smoke test |
| `npm audit --omit=dev` | Audit production dependencies |

## Architecture

- `client/`: React routes, accessible page components, Vite build, and the preserved PawPal CSS.
- `server/src/app.js`: Express middleware, API routing, security headers, and production static hosting.
- `server/src/routes/`, `schemas/`, and `services/`: authenticated API, Zod input validation, and business logic.
- `server/src/db/`: PostgreSQL pool, additive migrations, and guarded seed utilities.
- `db/migrations/`: numbered additive schema changes.
- `docs/api.http`: REST Client examples for the API.
- `docs/DEPLOY.md`: single-service deployment setup.

Authentication uses bcryptjs and signed HS256 JWTs in the `pawpal_token` httpOnly cookie. Access tokens are never kept in localStorage. PostgreSQL is accessed with parameterized SQL; no ORM is used.

## Demo accounts

When the optional seed data is installed, the development accounts are:

- Admin: `admin@pawpal.test` (user ID `admin`)
- Shelter owners: `sarah@rosecity.test`, `miguel@lonestar.test`, `priya@emerald.test`, `jordan@milehigh.test`
- Adopters: `alex@pawpal.test`, `jamie@pawpal.test`, `casey@pawpal.test`, `drew@pawpal.test`

Use the value configured in `SEED_PASSWORD`. Do not reuse it outside a local demo. The project does not publish a password in this README.

## Known limitations

- The app requires a reachable PostgreSQL service and completed migrations.
- Uploaded images and documents live in PostgreSQL because deployment disks may be ephemeral.
- Lighthouse scores depend on the target host and browser; record them from the deployed build using the steps in `docs/DEPLOY.md`.
- The build and API smoke verification do not replace manual cross-browser and responsive review.
