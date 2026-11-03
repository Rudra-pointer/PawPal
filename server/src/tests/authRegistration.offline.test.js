import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../db/pool.js', () => ({ query: queryMock }));
vi.mock('../config/env.js', () => ({ env: { JWT_SECRET: 'offline-auth-test-secret-with-sufficient-length', NODE_ENV: 'test', COOKIE_SECURE: false } }));

const { authRouter } = await import('../routes/auth.js');
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRouter);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({
  error: {
    code: error.errorCode || 'INTERNAL_ERROR',
    message: error.status < 500 ? error.message : 'An unexpected error occurred.',
    details: error.details || [],
  },
}));

const payload = {
  name: 'Alex Rivera', email: 'alex@example.com', userCode: 'Alex_R',
  password: 'PawPal123', role: 'adopter', contactNo: '+1 555 123 4567',
};
const registeredUser = {
  id: 'test-user-id', user_code: payload.userCode, name: payload.name,
  email: payload.email, contact_no: payload.contactNo, role: payload.role,
  status: 'active',
};
let passwordHash;

beforeEach(async () => {
  queryMock.mockReset();
  passwordHash = await bcrypt.hash(payload.password, 4);
});

describe('registration and login routes with an offline query mock', () => {
  it('registers an adopter and persists the optional contact number', async () => {
    queryMock.mockResolvedValue({ rows: [registeredUser] });
    const response = await request(app).post('/api/auth/register').send(payload);
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('adopter');
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toContain('user_code,name,email,contact_no,password_hash,role');
    expect(values[3]).toBe(payload.contactNo);
    expect(await bcrypt.compare(payload.password, values[4])).toBe(true);
  });

  it('registers a shelter user while public admin registration remains rejected', async () => {
    queryMock.mockResolvedValue({ rows: [{ ...registeredUser, role: 'shelter' }] });
    const shelter = await request(app).post('/api/auth/register').send({ ...payload, role: 'shelter' });
    expect(shelter.status).toBe(201);
    queryMock.mockClear();
    const admin = await request(app).post('/api/auth/register').send({ ...payload, role: 'admin' });
    expect(admin.status).toBe(400);
    expect(admin.body.error.details.some(issue => issue.path.includes('role'))).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects an email-style User ID with a field-specific Zod issue', async () => {
    const response = await request(app).post('/api/auth/register').send({ ...payload, userCode: 'alex@example.com' });
    expect(response.status).toBe(400);
    expect(response.body.error.details.some(issue => issue.path.includes('userCode'))).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('enforces the three to thirty character User ID length', async () => {
    for (const userCode of ['ab', 'a'.repeat(31)]) {
      const response = await request(app).post('/api/auth/register').send({ ...payload, userCode });
      expect(response.status).toBe(400);
      expect(response.body.error.details.some(issue => issue.path.includes('userCode'))).toBe(true);
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('requires at least eight password characters including a letter and a number', async () => {
    for (const password of ['short1', 'abcdefgh', '12345678']) {
      const response = await request(app).post('/api/auth/register').send({ ...payload, password });
      expect(response.status).toBe(400);
      expect(response.body.error.details.some(issue => issue.path.includes('password'))).toBe(true);
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns an email-specific error for a duplicate email', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'ux_users_email' }));
    const response = await request(app).post('/api/auth/register').send(payload);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EMAIL_TAKEN');
    expect(response.body.error.details[0].path).toEqual(['email']);
  });

  it('returns a User ID-specific error for a duplicate ID', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'ux_users_user_code' }));
    const response = await request(app).post('/api/auth/register').send(payload);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('USER_ID_TAKEN');
    expect(response.body.error.details[0].path).toEqual(['userCode']);
  });

  it('reports availability without returning private account information', async () => {
    queryMock.mockResolvedValue({ rows: [{ taken: true }] });
    const response = await request(app).get('/api/auth/availability?userCode=Alex_R');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false });
    expect(Object.keys(response.body)).toEqual(['available']);
  });

  it('reports available email and User ID values as available', async () => {
    queryMock.mockResolvedValue({ rows: [{ taken: false }] });
    const email = await request(app).get('/api/auth/availability?email=new%40example.com');
    const userCode = await request(app).get('/api/auth/availability?userCode=New_User');
    expect(email.body).toEqual({ available: true });
    expect(userCode.body).toEqual({ available: true });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('rejects empty and malformed availability values before querying', async () => {
    const empty = await request(app).get('/api/auth/availability');
    const malformed = await request(app).get('/api/auth/availability?userCode=bad%40email.com');
    expect(empty.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows registration with no contact number', async () => {
    queryMock.mockResolvedValue({ rows: [{ ...registeredUser, contact_no: null }] });
    const response = await request(app).post('/api/auth/register').send({ ...payload, contactNo: '' });
    expect(response.status).toBe(201);
    expect(queryMock.mock.calls[0][1][3]).toBeNull();
  });

  it('logs in by case-insensitive email and compares the bcrypt hash', async () => {
    queryMock.mockImplementation(async (sql, values) => sql.startsWith('SELECT id,user_code,name,email,role,status,password_hash')
      ? { rows: [{ ...registeredUser, password_hash: passwordHash }] }
      : { rows: [] });
    const response = await request(app).post('/api/auth/login').send({ identifier: payload.email.toUpperCase(), password: payload.password });
    expect(response.status).toBe(200);
    expect(queryMock.mock.calls[0][0]).toContain('lower(email)=lower($1) OR lower(user_code)=lower($1)');
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
  });

  it('logs in by case-insensitive User ID', async () => {
    queryMock.mockImplementation(async (sql) => sql.startsWith('SELECT id,user_code,name,email,role,status,password_hash')
      ? { rows: [{ ...registeredUser, password_hash: passwordHash }] }
      : { rows: [] });
    const response = await request(app).post('/api/auth/login').send({ identifier: payload.userCode.toUpperCase(), password: payload.password });
    expect(response.status).toBe(200);
  });

  it('returns the same generic invalid-credentials response for unknown users and wrong passwords', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const missing = await request(app).post('/api/auth/login').send({ identifier: 'missing@example.com', password: payload.password });
    queryMock.mockResolvedValue({ rows: [{ ...registeredUser, password_hash: passwordHash }] });
    const incorrect = await request(app).post('/api/auth/login').send({ identifier: payload.email, password: 'WrongPassword42' });
    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(missing.body.error.message).toBe('Invalid credentials');
    expect(incorrect.body.error.message).toBe(missing.body.error.message);
  });

  it('blocks a suspended account before accepting its correct password', async () => {
    queryMock.mockResolvedValue({ rows: [{ ...registeredUser, status: 'suspended', password_hash: passwordHash }] });
    const response = await request(app).post('/api/auth/login').send({ identifier: payload.email, password: payload.password });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
