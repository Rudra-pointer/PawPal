import 'dotenv/config';
import pg from 'pg';
import { runMigrations } from '../db/migrate.js';

export async function setup() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required to run PawPal tests.');
  if (new URL(connectionString).pathname !== '/pawpal_test') {
    throw new Error('PawPal tests are permitted only against the pawpal_test database.');
  }
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS database_name');
    if (result.rows[0]?.database_name !== 'pawpal_test') {
      throw new Error('PawPal test preflight found a database other than pawpal_test. No fixtures were written.');
    }
    await runMigrations(client);
  } finally {
    await client.end();
  }
}
