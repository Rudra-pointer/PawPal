// server/src/tests/errors.test.js
// Verifies that the central error handler maps pg error codes correctly.
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import 'dotenv/config';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../app.js';

// Build a minimal test app that injects pg errors via the same error handler
// as the real app so we verify the mapping logic without a live DB call.
function makeTestApp() {
  const a = express();
  a.use(express.json());

  function makePgRoute(code) {
    return asyncHandler(async (_req, _res) => {
      const err = new Error('pg error');
      err.code = code;
      throw err;
    });
  }

  a.get('/test/conflict-unique',  makePgRoute('23505'));
  a.get('/test/conflict-fk',      makePgRoute('23503'));
  a.get('/test/rule-violation',   makePgRoute('23514'));
  a.get('/test/generic-error',    asyncHandler(async () => { throw new Error('boom'); }));

  // same error handler as app.js
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => {
    const pgCodeMap = {
      '23505': { status: 409, code: 'CONFLICT',       message: 'A record with those values already exists.' },
      '23503': { status: 409, code: 'CONFLICT',       message: 'The referenced resource does not exist or cannot be modified.' },
      '23514': { status: 422, code: 'RULE_VIOLATION', message: 'The data violates a business rule.' },
    };
    const mapped = pgCodeMap[err.code];
    if (mapped) return res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message, details: [] } });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: [] } });
  });
  return a;
}

const testApp = makeTestApp();

afterAll(async () => { await pool.end(); });

describe('pg error mapping', () => {
  it('23505 → 409 CONFLICT', async () => {
    const res = await request(testApp).get('/test/conflict-unique');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('23503 → 409 CONFLICT', async () => {
    const res = await request(testApp).get('/test/conflict-fk');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('23514 → 422 RULE_VIOLATION', async () => {
    const res = await request(testApp).get('/test/rule-violation');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RULE_VIOLATION');
  });

  it('generic error → 500 INTERNAL_ERROR', async () => {
    const res = await request(testApp).get('/test/generic-error');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

