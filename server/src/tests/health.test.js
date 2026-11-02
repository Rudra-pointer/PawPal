// server/src/tests/health.test.js
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import 'dotenv/config';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

afterAll(async () => { await pool.end(); });

describe('GET /api/health', () => {
  it('returns 200 with status ok and db up', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('up');
    expect(typeof res.body.time).toBe('string');
  });
});

describe('Unknown /api/* route', () => {
  it('returns 404 with JSON error shape', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error).toHaveProperty('message');
  });
});

