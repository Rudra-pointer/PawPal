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
import {
  assertApprovedMigrationInventory,
  assertFreshProductionSchema,
  assertProductionDatabaseIdentity,
  assertVerifiedProductionConnection,
  buildDatabaseConnectionConfig,
  selectMigrationDatabaseUrl,
} from './connectionConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'db', 'migrations');

const useTestDatabase = process.env.RUN_ON_TEST_DB === '1' || env.NODE_ENV === 'test';
const dbUrl = selectMigrationDatabaseUrl({
  runOnTestDb: process.env.RUN_ON_TEST_DB,
  nodeEnv: env.NODE_ENV,
  testDatabaseUrl: env.TEST_DATABASE_URL,
  databaseUrl: env.DATABASE_URL,
});

const pool = new pg.Pool(buildDatabaseConnectionConfig(dbUrl, env.NODE_ENV, {
  max: 3,
}));

export async function runMigrations(client) {
  // Validate the complete SQL inventory before the first database write.
  const discoveredFiles = await readdir(MIGRATIONS_DIR);
  const files = assertApprovedMigrationInventory(discoveredFiles);

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
  if (
    env.NODE_ENV === 'production' &&
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new Error(
      'Insecure Node TLS environment detected. Refusing production database connection.'
    );
  }

  const client = await pool.connect();
  try {
    if (env.NODE_ENV === 'production') {
      assertVerifiedProductionConnection(client);
      const { rows: [target] } = await client.query(`
        SELECT current_database() AS database,
               current_user AS role,
               current_setting('server_version') AS server_version,
               current_setting('server_version_num')::int AS server_version_num
      `);
      assertProductionDatabaseIdentity({
        database: target.database,
        role: target.role,
        serverVersion: target.server_version,
        serverVersionNum: target.server_version_num,
      });

      const { rows: [schema] } = await client.query(`
        SELECT
          (
            SELECT count(*)::integer
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE'
          ) AS public_base_tables,
          (to_regclass('public.schema_migrations') IS NOT NULL)
            AS has_schema_migrations
      `);
      assertFreshProductionSchema({
        publicBaseTables: schema.public_base_tables,
        hasSchemaMigrations: schema.has_schema_migrations,
      });
    }
    if (useTestDatabase) {
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
