import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';
import { createPetWorld } from './helpers/petFixtures.js';

let world, inactiveWorld, fixture = {}, bulkIds = [];
const cleanups = [];

beforeAll(async () => {
  world = await createPetWorld(pool);
  cleanups.push(() => world.cleanup());
  fixture.nimbus = await world.pet({ name: 'Nimbus', species: 'dog', breed: 'Small Beagle', ageMonths: 8, gender: 'female', size: 'small', energy: 'high', description: 'Nimbus follows a bright trail', temperament: ['playful', 'curious'] });
  fixture.miso = await world.pet({ name: 'Miso', species: 'cat', breed: 'Domestic Shorthair', ageMonths: 36, gender: 'female', size: 'small', energy: 'medium', temperament: ['calm', 'affectionate'] });
  fixture.clover = await world.pet({ name: 'Clover', species: 'rabbit', breed: 'Holland Lop', ageMonths: 8, gender: 'female', size: 'small', energy: 'low', temperament: ['gentle'] });
  fixture.pending = await world.pet({ name: 'Piper Pending', species: 'dog', breed: 'Border Collie', ageMonths: 30, size: 'medium', status: 'pending' });
  fixture.adopted = await world.pet({ name: 'Bramble Adopted', species: 'dog', breed: 'Shepherd Mix', ageMonths: 60, size: 'large', status: 'adopted' });
  fixture.removed = await world.pet({ name: 'Removed Pet', status: 'removed' });
  for (let index = 0; index < 25; index++) {
    bulkIds.push(await world.pet({ name: `Page Fixture ${index}`, species: 'dog', breed: 'Page Hound', ageMonths: 18, size: 'medium' }));
  }
  inactiveWorld = await createPetWorld(pool, { city: 'Austin', state: 'TX', userStatus: 'suspended' });
  cleanups.push(() => inactiveWorld.cleanup());
  fixture.inactiveOwner = await inactiveWorld.pet({ name: 'Hidden Owner Pet', status: 'available' });
});

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await pool.end();
});

const browse = filters => request(app).get('/api/pets').query({ pageSize: 24, sort: 'name', ...filters });

describe('pet browse API (isolated fixtures in pawpal_test)', () => {
  it('returns the requested response shape and only available pets by default', async () => {
    const response = await browse({ pageSize: 100 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 24 });
    expect(response.body.total).toBeGreaterThanOrEqual(28);
    expect(response.body.items).toHaveLength(24);
    expect(response.body.items.every(item => item.status === 'available')).toBe(true);
    expect(response.body.items.map(item => item.id)).not.toContain(fixture.removed);
    expect(response.body.items.map(item => item.id)).not.toContain(fixture.inactiveOwner);
    expect(response.body.items[0]).toHaveProperty('ageLabel');
    expect(response.body.items[0]).toHaveProperty('primaryPhoto');
  });

  it('filters individually by species, breed, age group, gender, size, city, status, and energy', async () => {
    expect((await browse({ species: 'DOG' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
    expect((await browse({ breed: 'BEAG' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
    expect((await browse({ ageGroup: 'baby' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
    expect((await browse({ gender: 'female' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
    expect((await browse({ size: 'small' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
    expect((await browse({ city: 'portland' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
    expect((await browse({ status: 'pending' })).body.items.map(item => item.id)).toContain(fixture.pending);
    expect((await browse({ status: 'adopted' })).body.items.map(item => item.id)).toContain(fixture.adopted);
    expect((await browse({ energy: 'high' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
  });

  it('combines filters and matches breed case-insensitively by substring', async () => {
    const response = await browse({ species: 'dog', breed: 'bEaG', size: 'small', city: 'PORTLAND', energy: 'high' });
    expect(response.status).toBe(200);
    expect(response.body.items.map(item => item.id)).toEqual([fixture.nimbus]);
  });

  it('uses full-text search for normal queries and ILIKE for short prefixes', async () => {
    expect((await browse({ q: 'bright trail' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
    expect((await browse({ q: 'Nim' })).body.items.map(item => item.id)).toContain(fixture.nimbus);
  });

  it('paginates, sorts by age, and returns totals when the requested page is empty', async () => {
    const first = await browse({ page: 1, pageSize: 2, sort: 'age_asc' });
    const second = await browse({ page: 2, pageSize: 2, sort: 'age_asc' });
    expect(first.body.items).toHaveLength(2);
    expect(second.body.items).toHaveLength(2);
    expect(first.body.items[0].ageLabel).toBe('8 mo');
    const beyond = await browse({ page: 1000, pageSize: 2 });
    expect(beyond.body.items).toEqual([]);
    expect(beyond.body.total).toBe(first.body.total);
  });

  it('supports name and descending-age sort values deterministically', async () => {
    const names = await browse({ city: 'Portland', sort: 'name', pageSize: 24 });
    expect(names.status).toBe(200);
    const actualNames = names.body.items.map(item => item.name.toLowerCase());
    expect(actualNames).toEqual([...actualNames].sort());
    const ages = await browse({ city: 'Portland', sort: 'age_desc', pageSize: 24 });
    const toMonths = label => (Number(label.match(/(\d+) yr/)?.[1] ?? 0) * 12) + Number(label.match(/(\d+) mo/)?.[1] ?? 0);
    const descending = ages.body.items.map(item => toMonths(item.ageLabel));
    expect(descending).toEqual([...descending].sort((left, right) => right - left));
    expect(ages.body.items.length).toBeGreaterThan(0);
  });

  it('never returns removed pets and rejects removed as a filter value', async () => {
    const response = await browse({ status: 'available' });
    expect(response.body.items.map(item => item.id)).not.toContain(fixture.removed);
    expect((await browse({ status: 'removed' })).status).toBe(400);
  });

  it('hides pets whose owner is inactive and pets in unverified shelters', async () => {
    expect((await browse({ city: 'Austin' })).body.items.map(item => item.id)).not.toContain(fixture.inactiveOwner);
    const unverified = await createPetWorld(pool, { city: 'Salem', state: 'OR', verified: 'pending' });
    cleanups.push(() => unverified.cleanup());
    const hidden = await unverified.pet({ name: 'Unverified Listing' });
    expect((await browse({ city: 'Salem' })).body.items.map(item => item.id)).not.toContain(hidden);
  });

  it('rejects malformed filters with the standard validation error shape', async () => {
    const response = await browse({ species: 'cat/fox' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.any(String), details: expect.any(Array) });
  });
});
