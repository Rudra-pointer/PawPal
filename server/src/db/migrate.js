// server/src/db/migrate.js
// Idempotent migration runner.
// Usage: node server/src/db/migrate.js
// Uses DATABASE_URL unless RUN_ON_TEST_DB=1 is set (then TEST_DATABASE_URL).
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'db', 'migrations');

if (process.env.RUN_ON_TEST_DB === '1' && !env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is required for test migrations; refusing to fall back to DATABASE_URL.');
}
const dbUrl = process.env.RUN_ON_TEST_DB === '1' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
if (process.env.RUN_ON_TEST_DB === '1' && new URL(dbUrl).pathname !== '/pawpal_test') {
  throw new Error('Test migrations may connect only to the pawpal_test database.');
}

const pool = new pg.Pool({
  connectionString: dbUrl,
  max: 3,
  ssl: dbUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

export async function runMigrations(client) {
  // Ensure the migrations tracking table exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Read existing versions
  const { rows: applied } = await client.query(
    'SELECT version FROM schema_migrations'
  );
  const appliedSet = new Set(applied.map(r => r.version));

  // Read migration files sorted
  let files;
  try {
    const all = await readdir(MIGRATIONS_DIR);
    files = all.filter(f => f.endsWith('.sql')).sort();
  } catch {
    files = [];
  }

  const pending = files.filter(f => !appliedSet.has(f));

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    // The SQL file is already wrapped in BEGIN/COMMIT.
    // Execute it as-is, then record the version in a separate statement.
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
      [file]
    );
    console.log(`  ✓ Applied: ${file}`);
  }

  return pending.length;
}

async function main() {
  const client = await pool.connect();
  try {
    if (process.env.RUN_ON_TEST_DB === '1') {
      const { rows } = await client.query('SELECT current_database() AS database_name');
      if (rows[0]?.database_name !== 'pawpal_test') {
        throw new Error('Test migrations may run only when current_database() is pawpal_test.');
      }
    }
    const n = await runMigrations(client);
    console.log(`Applied ${n} new migration${n !== 1 ? 's' : ''}.`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[migrate] Fatal:', err.message);
    process.exitCode = 1;
  });
}
