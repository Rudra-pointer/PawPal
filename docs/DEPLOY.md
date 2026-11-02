# Deploy PawPal as one Render service

PawPal's production topology is one Node web service plus a managed PostgreSQL database. Express serves the built Vite client and API from one origin. No CORS configuration is needed.

## Before deployment

1. Provision a PostgreSQL 13+ database and run the numbered migrations with the migration command appropriate to that database.
2. Configure `DATABASE_URL`, a unique random `JWT_SECRET` (at least 32 characters), and a private `SEED_PASSWORD` in the host dashboard. Never put credentials in `render.yaml` or Git.
3. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, and `TRUST_PROXY=true` when the service is behind Render's proxy.
4. Do not run the demo seed on production unless you have reviewed the data and explicitly pass `--force`.

## Render configuration

`render.yaml` defines a single Node web service. Its build command is `npm ci --include=dev && npm run build`, its start command is `npm start`, and its health check is `/api/health`. Secret environment values use `sync: false` and must be entered in Render's dashboard.

Deploy the repository from the Render dashboard or its Git integration. Confirm the health endpoint returns JSON with `status: "ok"` and `db: "up"`. A database-unavailable response still has HTTP 200 so inspect the `db` field during initial setup.

## Release checks

Run locally before deployment:

```powershell
npm ci
npm run verify
npm audit
npm audit --omit=dev
```

After deploy, check security headers and refresh a nested route:

```powershell
Invoke-WebRequest -Method Head https://YOUR_HOST/api/health
Invoke-WebRequest https://YOUR_HOST/browse
```

The API response should include Helmet security headers. The `/browse` request should return the SPA entry point so client-side routing can resume.

## Lighthouse and responsive review

Run Lighthouse in Chrome DevTools against the deployed home page and record Performance, Accessibility, and Best Practices. The target is 90+ in each category; results vary with network, host, and image delivery. Also inspect Home, Browse, Pet Profile, Apply, Login, and Dashboard at 375, 768, and 1280 CSS pixels. Check keyboard focus, reduced motion, image alternatives, and browser-console errors. No score is claimed by the build process itself.
