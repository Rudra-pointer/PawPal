// server/src/db/pool.js
// pg connection pool. Exports query() and withTransaction().
import pg from 'pg';
import { env } from '../config/env.js';
import { buildDatabaseConnectionConfig } from './connectionConfig.js';

const { Pool } = pg;

const databaseUrl = env.NODE_ENV === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in test mode');
if (env.NODE_ENV === 'test' && new URL(databaseUrl).pathname !== '/pawpal_test') {
  throw new Error('Automated tests may connect only to the pawpal_test database.');
}
export const pool = new Pool(buildDatabaseConnectionConfig(databaseUrl, env.NODE_ENV, {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
}));

pool.on('error', err => {
  console.error('[pool] Unexpected client error:', err.message);
});

const transientConnectionCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '57P01', '57P03', '08003', '08006']);
const backoff = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function connectWithRetry({ connect = () => pool.connect(), wait = backoff } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await connect();
    } catch (error) {
      if (!transientConnectionCodes.has(error.code) || attempt >= 3) throw error;
      await wait(100 * (3 ** attempt));
    }
  }
}

/** Retry read-only wake-up failures; never replay a write after an uncertain connection reset. */
export async function query(text, params) {
  const retryRead = /^\s*(SELECT|SHOW|EXPLAIN)\b/i.test(text);
  for (let attempt = 0; ; attempt += 1) {
    const client = await connectWithRetry();
    let destroyed = false;
    try {
      return await client.query(text, params);
    } catch (error) {
      if (retryRead && transientConnectionCodes.has(error.code) && attempt < 3) {
        client.release(true);
        destroyed = true;
        await backoff(100 * (3 ** attempt));
        continue;
      }
      if (transientConnectionCodes.has(error.code)) {
        client.release(true);
        destroyed = true;
      }
      throw error;
    } finally {
      if (!destroyed) client.release();
    }
  }
}

/**
 * Run fn(client) inside a BEGIN/COMMIT/ROLLBACK block.
 * Always releases the client.
 */
export async function withTransaction(fn) {
  const client = await connectWithRetry();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

