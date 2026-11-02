import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { pool } from '../db/pool.js';
import { createPetWorld, newFixtureIdentity } from './helpers/petFixtures.js';

let world, adopterAgent, shelterAgent, adopterId, shelterId;
const petIds = {};
const removeUsers = [];

async function register(identity, role) {
  const agent = request.agent(app);
  const result = await agent.post('/api/auth/register').send({ ...identity, role });
  if (result.status === 201) removeUsers.push(result.body.user.id);
  expect(result.status).toBe(201);
  return { agent, id: result.body.user.id };
}

beforeAll(async () => {
  world = await createPetWorld(pool);
  petIds.available = await world.pet({ name: 'Saved Friend', species: 'cat', breed: 'Tabby', ageMonths: 20, size: 'small' });
  petIds.removed = await world.pet({ name: 'Removed Saved Pet', status: 'removed' });
  const adopter = await register(newFixtureIdentity(), 'adopter');
  adopterAgent = adopter.agent;
  adopterId = adopter.id;
  const shelterIdentity = newFixtureIdentity();
  const shelter = await register(shelterIdentity, 'shelter');
  shelterAgent = shelter.agent;
  shelterId = shelter.id;
});

afterAll(async () => {
  for (const id of removeUsers) await pool.query('DELETE FROM users WHERE id=$1', [id]);
  await world.cleanup();
  await pool.end();
});

describe('saved pet and filter metadata APIs (pawpal_test fixtures)', () => {
  it('requires an adopter session and rejects shelter-role access', async () => {
    expect((await request(app).get('/api/me/saved')).status).toBe(401);
    expect((await shelterAgent.get('/api/me/saved')).status).toBe(403);
    expect((await shelterAgent.post(`/api/me/saved/${petIds.available}`)).status).toBe(403);
    expect(shelterId).toBeTruthy();
  });

  it('validates pet IDs before writing a saved record', async () => {
    expect((await adopterAgent.post('/api/me/saved/not-a-uuid')).status).toBe(400);
    expect((await adopterAgent.delete('/api/me/saved/not-a-uuid')).status).toBe(400);
  });

  it('creates a saved record idempotently', async () => {
    const first = await adopterAgent.post(`/api/me/saved/${petIds.available}`);
    const second = await adopterAgent.post(`/api/me/saved/${petIds.available}`);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ saved: true, petId: petIds.available });
    expect(second.status).toBe(200);
    const count = await pool.query('SELECT count(*)::int AS count FROM saved_pets WHERE user_id=$1 AND pet_id=$2', [adopterId, petIds.available]);
    expect(count.rows[0].count).toBe(1);
  });

  it('returns the adopter own saved list and pagination metadata', async () => {
    const response = await adopterAgent.get('/api/me/saved?page=1&pageSize=100');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 1, page: 1, pageSize: 50, totalPages: 1 });
    expect(response.body.items[0]).toMatchObject({ id: petIds.available, name: 'Saved Friend', species: 'cat' });
    expect(response.body.items[0].primaryPhoto).toBeNull();
  });

  it('deletes only the adopter saved row and is safe to repeat', async () => {
    const first = await adopterAgent.delete(`/api/me/saved/${petIds.available}`);
    const second = await adopterAgent.delete(`/api/me/saved/${petIds.available}`);
    expect(first.body).toMatchObject({ saved: false, petId: petIds.available });
    expect(second.status).toBe(200);
    expect((await adopterAgent.get('/api/me/saved')).body).toMatchObject({ items: [], total: 0 });
  });

  it('does not allow saving removed or hidden pets', async () => {
    const response = await adopterAgent.post(`/api/me/saved/${petIds.removed}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('returns schema-backed filter options and counts visible available pets', async () => {
    const response = await request(app).get('/api/meta/filters');
    expect(response.status).toBe(200);
    expect(response.body.sizes).toEqual(['small', 'medium', 'large', 'xlarge']);
    expect(response.body.ageGroups).toEqual(['baby', 'young', 'adult', 'senior']);
    const expectedSpecies = await pool.query(`SELECT count(*)::int AS count FROM pets p
      JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
      JOIN users u ON u.id=s.owner_user_id AND u.status='active'
      WHERE p.status='available' AND p.species='cat'`);
    const expectedBreed = await pool.query(`SELECT count(*)::int AS count FROM pets p
      JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
      JOIN users u ON u.id=s.owner_user_id AND u.status='active'
      WHERE p.status='available' AND p.species='cat' AND p.breed='Tabby'`);
    const expectedCity = await pool.query(`SELECT count(*)::int AS count FROM pets p
      JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
      JOIN users u ON u.id=s.owner_user_id AND u.status='active'
      WHERE p.status='available' AND s.city='Portland' AND s.state='OR'`);
    expect(response.body.species.find(item => item.species === 'cat')).toEqual({ species: 'cat', count: expectedSpecies.rows[0].count });
    expect(response.body.breeds.find(item => item.species === 'cat' && item.breed === 'Tabby')).toEqual({ species: 'cat', breed: 'Tabby', count: expectedBreed.rows[0].count });
    expect(response.body.cities.find(item => item.city === 'Portland' && item.state === 'OR')).toEqual({ city: 'Portland', state: 'OR', count: expectedCity.rows[0].count });
    expect(expectedSpecies.rows[0].count).toBeGreaterThanOrEqual(1);
    expect(expectedBreed.rows[0].count).toBeGreaterThanOrEqual(1);
    expect(expectedCity.rows[0].count).toBeGreaterThanOrEqual(1);
  });

  it('uses validated UUIDs for missing photo and pet endpoints', async () => {
    const unknown = randomUUID();
    expect((await request(app).get(`/api/photos/${unknown}`)).status).toBe(404);
    expect((await adopterAgent.post(`/api/me/saved/${unknown}`)).status).toBe(404);
  });
});
