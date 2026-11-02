import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';
import { createPetWorld } from './helpers/petFixtures.js';

let world, ids = {};
beforeAll(async () => {
  world = await createPetWorld(pool);
  ids.base = await world.pet({ name: 'Nori', species: 'dog', breed: 'Terrier Mix', ageMonths: 8, size: 'small', energy: 'medium', temperament: ['calm', 'curious'], spayed: true, houseTrained: true, healthNotes: 'Seasonal allergies', goodChildren: 'unknown', goodDogs: 'yes', goodCats: 'no' });
  ids.best = await world.pet({ name: 'Calm Companion', species: 'dog', breed: 'Terrier', ageMonths: 20, size: 'small', energy: 'medium', temperament: ['calm', 'curious'] });
  ids.second = await world.pet({ name: 'Playful Small Dog', species: 'dog', breed: 'Terrier', ageMonths: 30, size: 'small', energy: 'high', temperament: ['calm'] });
  ids.third = await world.pet({ name: 'Medium Calm Dog', species: 'dog', breed: 'Hound', ageMonths: 48, size: 'medium', energy: 'medium', temperament: ['calm'] });
  ids.fourth = await world.pet({ name: 'Large Quiet Dog', species: 'dog', breed: 'Retriever', ageMonths: 72, size: 'large', energy: 'low', temperament: ['quiet'] });
  ids.otherSpecies = await world.pet({ name: 'Unrelated Cat', species: 'cat', breed: 'Tabby', ageMonths: 30, size: 'small' });
  ids.pending = await world.pet({ name: 'Still Pending', status: 'pending' });
  ids.adopted = await world.pet({ name: 'Already Home', status: 'adopted' });
  ids.removed = await world.pet({ name: 'No Longer Listed', status: 'removed' });
  ids.removedPhoto = await world.photo(ids.removed, { url: 'https://images.unsplash.com/removed-private-photo' });
  await pool.query('UPDATE pets SET bonded_pet_id=$1 WHERE id=$2', [ids.best, ids.base]);
  await pool.query('UPDATE pets SET bonded_pet_id=$1 WHERE id=$2', [ids.base, ids.best]);
  const { rows: [{ today }] } = await pool.query('SELECT CURRENT_DATE::text AS today');
  const dateOffset = days => {
    const value = new Date(`${today}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  await world.vaccination(ids.base, 'dog', 'RABIES', { givenOn: dateOffset(-60), nextDueOn: dateOffset(14) });
  await world.vaccination(ids.base, 'dog', 'DHPP', { givenOn: dateOffset(-60), nextDueOn: dateOffset(-2) });
  ids.photo = await world.photo(ids.base, { url: 'https://images.unsplash.com/photo-1552053831-71594a27632d', primary: true });
});

afterAll(async () => { await world.cleanup(); await pool.end(); });

describe('pet profile and photo APIs (pawpal_test fixtures)', () => {
  it('returns profile details, shelter, photos, tri-state flags, health, vaccinations, readiness, and bond partner', async () => {
    const response = await request(app).get(`/api/pets/${ids.base}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: ids.base, name: 'Nori', species: 'dog', status: 'available' });
    expect(response.body).toMatchObject({ shelterId: world.shelterId, bondedPetId: ids.best, externalId: null });
    expect(response.body.shelter).toMatchObject({ name: expect.stringContaining('Fixture Shelter'), city: 'Portland', state: 'OR', verified: true });
    expect(response.body.goodWith).toEqual({ children: 'unknown', dogs: 'yes', cats: 'no' });
    expect(response.body.health.notes).toBe('Seasonal allergies');
    expect(response.body.photos[0].url).toContain('images.unsplash.com');
    expect(response.body.bondedPartner).toEqual({ id: ids.best, name: 'Calm Companion' });
    expect(response.body.vaccinations.find(vaccine => vaccine.code === 'RABIES').status).toBe('due_soon');
    expect(response.body.vaccinations.find(vaccine => vaccine.code === 'DHPP').status).toBe('overdue');
    expect(response.body.readiness).toContainEqual({ label: 'Vaccinated', ready: false });
    expect(response.body.readiness).toContainEqual({ label: 'House-trained', ready: true });
    expect(response.headers['content-security-policy']).toContain('https://images.unsplash.com');
  });

  it('keeps pending and adopted profile pages while returning 404 for removed or missing pets', async () => {
    const pending = await request(app).get(`/api/pets/${ids.pending}`);
    expect(pending.status).toBe(200);
    expect(pending.body.vaccinations.filter(vaccine => vaccine.isCore).every(vaccine => vaccine.status === 'not_recorded')).toBe(true);
    expect(pending.body.readiness).toContainEqual({ label: 'Vaccinated', ready: false });
    expect((await request(app).get(`/api/pets/${ids.adopted}`)).status).toBe(200);
    expect((await request(app).get(`/api/pets/${ids.removed}`)).status).toBe(404);
    expect((await request(app).get('/api/pets/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await request(app).get('/api/pets/not-a-uuid')).status).toBe(400);
  });

  it('ranks up to four available similar pets, never includes itself, and excludes other species', async () => {
    const response = await request(app).get(`/api/pets/${ids.base}`);
    const similarIds = response.body.similarPets.map(pet => pet.id);
    expect(similarIds).toHaveLength(4);
    expect(similarIds).not.toContain(ids.base);
    expect(similarIds).not.toContain(ids.otherSpecies);
    expect(similarIds[0]).toBe(ids.best);
    expect(similarIds).toContain(ids.second);
  });

  it('streams stored bytes with the saved MIME type and cache policy', async () => {
    const photoId = await world.photo(ids.best, { data: Buffer.from([137, 80, 78, 71]), mimeType: 'image/png' });
    const response = await request(app).get(`/api/photos/${photoId}`).buffer(true).parse((res, callback) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
    expect(response.body).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('redirects URL photos and validates photo IDs', async () => {
    const result = await request(app).get(`/api/photos/${ids.photo}`).redirects(0);
    expect(result.status).toBe(302);
    expect(result.headers.location).toContain('https://images.unsplash.com');
    expect((await request(app).get('/api/photos/not-a-uuid')).status).toBe(400);
    expect((await request(app).get(`/api/photos/${ids.removedPhoto}`)).status).toBe(404);
  });
});
