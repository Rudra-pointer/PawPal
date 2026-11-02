// server/src/server.js
// Entry point — loads env, starts Express, handles graceful shutdown.
import 'dotenv/config';
import { env } from './config/env.js';
import { app } from './app.js';
import { pool } from './db/pool.js';

const server = app.listen(env.PORT, () => {
  if (env.NODE_ENV === 'production') console.log(JSON.stringify({ level: 'info', message: 'server_started', port: env.PORT, nodeEnv: env.NODE_ENV }));
  else console.log(`🐾  PawPal API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// ── Graceful shutdown on SIGTERM ──────────────────────────────────────────────
async function shutdown(signal) {
  const log = (level, message, extra = {}) => {
    const entry = { level, message, ...extra };
    if (env.NODE_ENV === 'production') console.log(JSON.stringify(entry));
    else console.log(`[server] ${message}`, extra);
  };
  const errorLog = (message, error) => {
    if (env.NODE_ENV === 'production') console.error(JSON.stringify({ level: 'error', message, code: error?.code || 'SHUTDOWN_ERROR' }));
    else console.error(`[server] ${message}`, error?.message || 'unknown error');
  };
  log('info', 'shutdown_started', { signal });
  server.close(async () => {
    try {
      await pool.end();
      log('info', 'database_pool_closed', { signal });
      process.exit(0);
    } catch (err) {
      errorLog('shutdown_failed', err);
      process.exit(1);
    }
  });
  // Force exit after 10 s if connections hang
  setTimeout(() => {
    if (env.NODE_ENV === 'production') console.error(JSON.stringify({ level: 'error', message: 'shutdown_timeout', signal }));
    else console.error('[server] Force exit after timeout.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

