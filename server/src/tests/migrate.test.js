// server/src/tests/migrate.test.js
import { describe, it, expect, afterAll } from 'vitest';
import 'dotenv/config';
import pg from 'pg';
import { env } from '../config/env.js';
import { runMigrations } from '../db/migrate.js';

const testPool = new pg.Pool({
  connectionString: env.TEST_DATABASE_URL,
  max: 2,
});

afterAll(async () => { await testPool.end(); });

describe('runMigrations', () => {
  it('applies migrations on first run (>= 0)', async () => {
    const client = await testPool.connect();
    try {
      const n = await runMigrations(client);
      expect(n).toBeGreaterThanOrEqual(0);
    } finally {
      client.release();
    }
  });

  it('returns 0 on a second run (idempotent)', async () => {
    const client = await testPool.connect();
    try {
      const n = await runMigrations(client);
      expect(n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('keeps pet and vaccine species open text and installs a generic vaccine option', async () => {
    const { rows } = await testPool.query(`
      SELECT table_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('pets','vaccine_types') AND column_name='species'
    `);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: 'pets', data_type: 'text' }),
      expect.objectContaining({ table_name: 'vaccine_types', data_type: 'text' }),
    ]));
    const generic = await testPool.query("SELECT code,is_generic FROM vaccine_types WHERE species='__generic__' AND code='OTHER'");
    expect(generic.rows[0]).toEqual({ code: 'OTHER', is_generic: true });
  });
});

