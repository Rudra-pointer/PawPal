// server/src/app.js
// Express application (separated from server.js so tests can import it cleanly).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pool } from './db/pool.js';
import { env } from './config/env.js';
import { authRouter, requireRole } from './routes/auth.js';
import { petsRouter } from './routes/pets.js';
import { metaRouter } from './routes/meta.js';
import { photosRouter } from './routes/photos.js';
import { savedPetsRouter } from './routes/savedPets.js';
import { applicationsRouter, shelterAdoptionsRouter } from './routes/applications.js';
import { sheltersRouter } from './routes/shelters.js';
import { shelterPetsRouter } from './routes/shelterPets.js';
import { adminRouter, reportsRouter } from './routes/admin.js';
import { matchingRouter } from './routes/matching.js';
import { rateLimit } from './middleware/rateLimit.js';

export const app = express();

// ── Trust proxy ──────────────────────────────────────────────────────────────
if (env.TRUST_PROXY) app.set('trust proxy', 1);

// ── Security & parsing middleware ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://images.unsplash.com'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on('finish', () => {
    const ms = Date.now() - start;
    if (env.NODE_ENV === 'production') {
      console.log(JSON.stringify({ level: 'info', method: req.method, path: req.path, status: _res.statusCode, durationMs: ms }));
    } else if (env.NODE_ENV !== 'test') {
      console.log(`${req.method} ${req.path} ${_res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// ── asyncHandler helper ───────────────────────────────────────────────────────
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Apply the same per-IP API ceiling to health checks and all API paths.
export const apiRateLimit = rateLimit({ max: 300 });
app.use('/api', apiRateLimit);

// ── Health endpoint ───────────────────────────────────────────────────────────
app.get('/api/health', asyncHandler(async (_req, res) => {
  let dbStatus = 'down';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'up';
  } catch {
    // db unreachable — still return 200 with db:down so load-balancers can see it
  }
  res.json({ status: 'ok', db: dbStatus, time: new Date().toISOString() });
}));

// ── API router (future routes attach here) ───────────────────────────────────
const apiRouter = express.Router();
apiRouter.use('/auth', rateLimit({ max: 90, keyPrefix: 'auth', code: 'AUTH_RATE_LIMITED', message: 'Too many authentication requests. Please try again later.' }));
apiRouter.use('/auth', authRouter);
apiRouter.use('/match', matchingRouter);
apiRouter.use('/pets', petsRouter);
apiRouter.use('/meta', metaRouter);
apiRouter.use('/photos', photosRouter);
apiRouter.use('/me/saved', savedPetsRouter);
apiRouter.use('/applications', applicationsRouter);
apiRouter.use('/shelters', sheltersRouter);
apiRouter.use('/shelter', shelterAdoptionsRouter);
apiRouter.use('/shelter', shelterPetsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.get('/admin/ping', ...requireRole('admin'), (_req, res) => res.json({ status: 'ok' }));
app.use('/api', apiRouter);

// ── Unknown /api/* routes → JSON 404 ─────────────────────────────────────────
app.use('/api/*', (_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'The requested API endpoint does not exist.', details: [] },
  });
});

if (env.NODE_ENV === 'production') {
  const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
  app.use(express.static(clientDist, {
    index: false,
    setHeaders(res, filePath) {
      const isHashedAsset = /[.-][A-Z0-9_-]{8,}\.(?:js|css|svg|png|jpe?g|webp|woff2?)$/i.test(path.basename(filePath));
      res.setHeader('Cache-Control', isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.get('*', (_req, res, next) => res.sendFile(path.join(clientDist, 'index.html'), error => error && next(error)));
}

// ── Central error handler ─────────────────────────────────────────────────────
// Maps pg constraint errors to semantically correct HTTP codes.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: { code: 'UPLOAD_LIMIT_EXCEEDED', message: 'The uploaded files exceed the allowed size or count.', details: [] } });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_PART_COUNT') {
    return res.status(400).json({ error: { code: 'INVALID_UPLOAD', message: 'The upload contains unexpected fields or too many parts.', details: [] } });
  }
  const pgCodeMap = {
    '23505': { status: 409, code: 'CONFLICT',        message: 'A record with those values already exists.' },
    '23503': { status: 409, code: 'CONFLICT',        message: 'The referenced resource does not exist or cannot be modified.' },
    '23514': { status: 422, code: 'RULE_VIOLATION',  message: 'The data violates a business rule.' },
  };

  const mapped = pgCodeMap[err.code];
  if (mapped) {
    return res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: [] },
    });
  }

  const status  = err.status ?? err.statusCode ?? 500;
  const code    = err.errorCode ?? 'INTERNAL_ERROR';
  const message = status < 500 ? err.message : 'An unexpected error occurred.';
  const details = err.details ?? [];
  const stack   = env.NODE_ENV !== 'production' ? err.stack : undefined;

  if (status >= 500) {
    if (env.NODE_ENV === 'production') console.error(JSON.stringify({ level: 'error', code, status }));
    else console.error('[error]', err.message, err.stack);
  }

  res.status(status).json({ error: { code, message, details, ...(stack ? { stack } : {}) } });
});

