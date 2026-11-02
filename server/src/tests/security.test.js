import { describe, expect, it, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { apiRateLimit, app } from '../app.js';
import { pool, connectWithRetry } from '../db/pool.js';
import { getCookieOptions } from '../routes/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

afterAll(async () => { await pool.end(); });

describe('Prompt 7 security hardening', () => {
  it('serves the restrictive CSP with only the required external image/font origins', async () => {
    const response = await request(app).get('/api/not-a-route');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain('https://fonts.googleapis.com');
    expect(response.headers['content-security-policy']).toContain('https://fonts.gstatic.com');
    expect(response.headers['content-security-policy']).toContain('https://images.unsplash.com');
    expect(response.headers['content-security-policy']).not.toContain('https:;');
    const directives = response.headers['content-security-policy'].split(';').map(value => value.trim());
    expect(directives.find(value => value.startsWith('style-src '))).not.toContain("'unsafe-inline'");
    expect(directives).toContain("style-src-attr 'unsafe-inline'");
  });

  it('rate-limits by client IP and returns the standard error shape', async () => {
    const limitedApp = express();
    limitedApp.get('/limited', rateLimit({ max: 1, keyPrefix: `test-${Date.now()}` }), (_req, res) => res.json({ ok: true }));
    expect((await request(limitedApp).get('/limited')).status).toBe(200);
    const blocked = await request(limitedApp).get('/limited');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED', message: expect.any(String), details: [] });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('retries only transient connection acquisition failures with back-off', async () => {
    let attempts = 0;
    const waits = [];
    const client = { id: 'connected' };
    const result = await connectWithRetry({
      connect: async () => { attempts += 1; if (attempts < 4) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return client; },
      wait: async ms => waits.push(ms),
    });
    expect(result).toBe(client);
    expect(attempts).toBe(4);
    expect(waits).toEqual([100, 300, 900]);
  });

  it('does not retry non-transient connection failures', async () => {
    let attempts = 0;
    await expect(connectWithRetry({ connect: async () => { attempts += 1; throw Object.assign(new Error('bad credentials'), { code: '28P01' }); }, wait: async () => {} })).rejects.toMatchObject({ code: '28P01' });
    expect(attempts).toBe(1);
  });

  it('uses httpOnly SameSite=Lax cookies and Secure in production', () => {
    expect(getCookieOptions({ NODE_ENV: 'production', COOKIE_SECURE: false })).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true });
    expect(getCookieOptions({ NODE_ENV: 'development', COOKIE_SECURE: false })).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false });
  });

  it('refuses a short production JWT secret without printing its value', () => {
    const workspace = fileURLToPath(new URL('../../..', import.meta.url));
    const secret = 'short-private-test-value';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./server/src/config/env.js')"], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret, DATABASE_URL: 'postgres://invalid:invalid@localhost:5432/pawpal' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production requires a non-default JWT_SECRET');
    expect(result.stderr).not.toContain(secret);
  });

  it('refuses the unchanged JWT placeholder from .env.example in production', () => {
    const workspace = fileURLToPath(new URL('../../..', import.meta.url));
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const placeholder = example.match(/^JWT_SECRET=(.+)$/m)?.[1];
    expect(placeholder).toBeTruthy();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./server/src/config/env.js')"], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: placeholder, DATABASE_URL: 'postgres://invalid:invalid@localhost:5432/pawpal' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production requires a non-default JWT_SECRET');
    expect(`${result.stdout}${result.stderr}`).not.toContain(placeholder);
  });

  it('refuses production seeding without --force before database access', () => {
    const workspace = fileURLToPath(new URL('../../..', import.meta.url));
    const demoPassword = 'NeverPrintThisDemoPassword123';
    const result = spawnSync(process.execPath, ['server/src/db/seed.js'], {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://invalid:invalid@localhost:5432/pawpal',
        JWT_SECRET: 'a-random-production-test-secret-with-more-than-32-chars',
        SEED_PASSWORD: demoPassword,
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Refusing to seed a production database');
    expect(`${result.stdout}${result.stderr}`).not.toContain(demoPassword);
  });

  it('uses the 300-request limit and applies it to the health route', async () => {
    let allowed = 0, blocked;
    const requestContext = { ip: `security-test-${Date.now()}` };
    const responseContext = { set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { blocked = { status: this.statusCode, body }; return this; } };
    for (let index = 0; index < 301; index += 1) apiRateLimit(requestContext, responseContext, () => { allowed += 1; });
    expect(allowed).toBe(300);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.headers['ratelimit-limit']).toBe('300');
  });
});
