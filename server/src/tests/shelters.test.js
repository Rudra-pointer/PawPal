import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { pool } from '../db/pool.js';
import { newFixtureIdentity } from './helpers/petFixtures.js';

let adopterAgent;
const userIds = [];
const shelterIds = [];
const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const fields = suffix => ({
  name: `Fixture Shelter ${suffix}`, description: 'A shelter used only by isolated tests.',
  addressLine: '42 Test Lane', city: 'Portland', state: 'OR', postcode: '97201', country: 'US',
  contactEmail: `shelter_${suffix}@pawpal.test`, contactPhone: '+1 555 0100', website: 'https://shelter.example.test',
});

async function register(role) {
  const agent = request.agent(app);
  const result = await agent.post('/api/auth/register').send({ ...newFixtureIdentity(), role });
  expect(result.status).toBe(201);
  userIds.push(result.body.user.id);
  return agent;
}

function addProfileFields(test, data) {
  for (const [key, value] of Object.entries(data)) test.field(key, String(value));
  return test;
}

beforeAll(async () => {
  const { rows } = await pool.query('SELECT current_database() AS name');
  if (rows[0]?.name !== 'pawpal_test') throw new Error('Shelter integration tests require pawpal_test; no fixture writes were made.');
  adopterAgent = await register('adopter');
});

afterAll(async () => {
  for (const id of shelterIds) await pool.query('DELETE FROM shelters WHERE id=$1', [id]);
  for (const id of userIds) await pool.query('DELETE FROM users WHERE id=$1', [id]);
  await pool.end();
});

describe('shelter registration and document validation (pawpal_test fixtures)', () => {
  it('registers a pending shelter with a verified PDF and exposes metadata only', async () => {
    const shelterAgent = await register('shelter');
    const data = fields(randomUUID().slice(0, 8));
    const response = await addProfileFields(shelterAgent.post('/api/shelters'), data)
      .attach('documents', pdf, { filename: 'proof.pdf', contentType: 'application/pdf' })
      .attach('documents', pdf, { filename: 'address.pdf', contentType: 'application/pdf' })
      .attach('documents', pdf, { filename: 'registration.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(201);
    expect(response.body.shelter).toMatchObject({ name: data.name, verification_status: 'pending' });
    expect(response.body.documentCount).toBe(3);
    shelterIds.push(response.body.shelter.id);
    const mine = await shelterAgent.get('/api/shelters/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.documents).toHaveLength(3);
    const proof = mine.body.documents.find(document => document.file_name === 'proof.pdf');
    expect(proof).toMatchObject({ file_name: 'proof.pdf', mime_type: 'application/pdf' });
    expect(proof.data).toBeUndefined();
  });

  it('updates the owner shelter profile and prevents a duplicate profile', async () => {
    const shelterAgent = await register('shelter');
    const data = fields(randomUUID().slice(0, 8));
    const create = await addProfileFields(shelterAgent.post('/api/shelters'), data)
      .attach('documents', pdf, { filename: 'proof.pdf', contentType: 'application/pdf' });
    expect(create.status).toBe(201);
    shelterIds.push(create.body.shelter.id);
    expect((await shelterAgent.put('/api/shelters/mine').send({ description: 'Updated test description.' })).body.shelter.description).toBe('Updated test description.');
    const duplicate = await addProfileFields(shelterAgent.post('/api/shelters'), fields(randomUUID().slice(0, 8)))
      .attach('documents', pdf, { filename: 'proof.pdf', contentType: 'application/pdf' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('SHELTER_EXISTS');
  });

  it('rejects mismatched extension, MIME and file signature', async () => {
    const shelterAgent = await register('shelter');
    const fakeExtension = await addProfileFields(shelterAgent.post('/api/shelters'), fields(randomUUID().slice(0, 8)))
      .attach('documents', pdf, { filename: 'proof.jpg', contentType: 'application/pdf' });
    expect(fakeExtension.status).toBe(400);
    expect(fakeExtension.body.error.code).toBe('INVALID_DOCUMENT');
    const fakeContent = Buffer.from('not a PDF document');
    const invalid = await addProfileFields(shelterAgent.post('/api/shelters'), fields(randomUUID().slice(0, 8)))
      .attach('documents', fakeContent, { filename: 'proof.pdf', contentType: 'application/pdf' });
    expect(invalid.status).toBe(400);
  });

  it('enforces the document size, count and role limits', async () => {
    const shelterAgent = await register('shelter');
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 65);
    oversized.write('%PDF-1.7');
    oversized.write('%%EOF', oversized.length - 5);
    const tooLarge = await addProfileFields(shelterAgent.post('/api/shelters'), fields(randomUUID().slice(0, 8)))
      .attach('documents', oversized, { filename: 'large.pdf', contentType: 'application/pdf' });
    expect(tooLarge.status).toBe(413);
    const tooMany = addProfileFields(shelterAgent.post('/api/shelters'), fields(randomUUID().slice(0, 8)));
    for (let index = 0; index < 4; index++) tooMany.attach('documents', pdf, { filename: `proof${index}.pdf`, contentType: 'application/pdf' });
    expect((await tooMany).status).toBe(413);
    expect((await adopterAgent.get('/api/shelters/mine')).status).toBe(403);
    expect((await request(app).get('/api/shelters/mine')).status).toBe(401);
  });

  it('requires at least one valid document and reports missing shelter profiles', async () => {
    const shelterAgent = await register('shelter');
    const empty = await addProfileFields(shelterAgent.post('/api/shelters'), fields(randomUUID().slice(0, 8)));
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
    const absent = await shelterAgent.get('/api/shelters/mine');
    expect(absent.status).toBe(404);
  });
});
