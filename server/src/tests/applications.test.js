import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { createPetWorld, newFixtureIdentity } from './helpers/petFixtures.js';

let world, otherWorld, unverifiedWorld, shelterAgent, otherShelterAgent, adopterA, adopterB, adopterC, adminCookie;
const appIds = [];
const userIds = [];
const pets = {};

async function register(role) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send({ ...newFixtureIdentity(), role });
  expect(response.status).toBe(201);
  userIds.push(response.body.user.id);
  return { agent, id: response.body.user.id };
}

function createAdminCookie(id) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const unsigned = `${head}.${body}`;
  const signature = createHmac('sha256', env.JWT_SECRET).update(unsigned).digest('base64url');
  return `pawpal_token=${unsigned}.${signature}`;
}

function applicationPayload(petId, overrides = {}) {
  return {
    petId,
    applicantName: 'Test Adopter',
    applicantEmail: 'applicant@pawpal.test',
    contactNo: '+1 555 0100',
    addressLine: '12 Test Street',
    city: 'Portland',
    state: 'OR',
    postcode: '97201',
    homeType: 'house_with_yard',
    ownership: 'own',
    householdAdults: 2,
    hasChildren: false,
    youngestChildAge: null,
    otherPets: '',
    experience: 'some',
    hoursAlonePerDay: 3,
    reason: 'We have prepared a loving home for this pet.',
    ...overrides,
  };
}

async function submit(agent, petId, overrides = {}) {
  const response = await agent.post('/api/applications').send(applicationPayload(petId, overrides));
  if (response.body.application?.id) appIds.push(response.body.application.id);
  return response;
}

async function review(applicationId, agent = shelterAgent) {
  const start = await agent.patch(`/api/applications/${applicationId}/status`).send({ to: 'under_review' });
  expect(start.status).toBe(200);
  return start;
}

async function passChecks(applicationId, agent = shelterAgent, { renter = false, route = 'home_check' } = {}) {
  const checks = ['identity', 'address', 'household_agreement', route].map(checkType => ({ checkType, result: 'passed' }));
  if (renter) checks.push({ checkType: 'landlord_permission', result: 'passed' });
  const response = await agent.patch(`/api/applications/${applicationId}/checks`).send({ checks });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  const { rows } = await pool.query('SELECT current_database() AS name');
  if (rows[0]?.name !== 'pawpal_test') throw new Error('Application integration tests require pawpal_test; no fixture writes were made.');
  const shelter = await register('shelter');
  shelterAgent = shelter.agent;
  const otherShelter = await register('shelter');
  otherShelterAgent = otherShelter.agent;
  const unverifiedShelter = await register('shelter');
  world = await createPetWorld(pool, { ownerUserId: shelter.id });
  otherWorld = await createPetWorld(pool, { ownerUserId: otherShelter.id });
  unverifiedWorld = await createPetWorld(pool, { ownerUserId: unverifiedShelter.id, verified: 'pending' });
  pets.one = await world.pet({ name: `Application pet ${world.suffix}` });
  pets.two = await world.pet({ name: `Application pet two ${world.suffix}` });
  pets.three = await world.pet({ name: `Application pet three ${world.suffix}` });
  pets.four = await world.pet({ name: `Application pet four ${world.suffix}` });
  pets.otherShelter = await otherWorld.pet({ name: `Other shelter pet ${otherWorld.suffix}` });
  pets.unverifiedShelter = await unverifiedWorld.pet({ name: `Unverified shelter pet ${unverifiedWorld.suffix}` });
  adopterA = await register('adopter');
  adopterB = await register('adopter');
  adopterC = await register('adopter');

  const admin = await pool.query(`
    INSERT INTO users (user_code,name,email,password_hash,role,status)
    VALUES ($1,'Fixture Admin',$2,'not-a-login-hash','admin','active') RETURNING id
  `, [`admin_${randomUUID().replaceAll('-', '').slice(0, 20)}`, `admin_${randomUUID().replaceAll('-', '')}@pawpal.test`]);
  userIds.push(admin.rows[0].id);
  adminCookie = createAdminCookie(admin.rows[0].id);
});

afterAll(async () => {
  if (appIds.length) await pool.query('DELETE FROM applications WHERE id=ANY($1::uuid[])', [appIds]);
  if (world) await world.cleanup();
  if (otherWorld) await otherWorld.cleanup();
  if (unverifiedWorld) await unverifiedWorld.cleanup();
  for (const id of userIds) await pool.query('DELETE FROM users WHERE id=$1', [id]);
  await pool.end();
});

afterEach(async () => {
  if (appIds.length) {
    await pool.query('DELETE FROM applications WHERE id=ANY($1::uuid[])', [appIds]);
    appIds.length = 0;
  }
  const resettable = [pets.one, pets.two, pets.three, pets.four, pets.otherShelter].filter(Boolean);
  if (resettable.length) await pool.query("UPDATE pets SET status='available' WHERE id=ANY($1::uuid[])", [resettable]);
});

describe('application lifecycle API (isolated pawpal_test fixtures)', () => {
  it('submits an application, stores advisory flags, and returns the adopter list', async () => {
    const response = await submit(adopterA.agent, pets.one, { experience: 'first_time', homeType: 'apartment' });
    expect(response.status).toBe(201);
    expect(response.body.application).toMatchObject({ status: 'submitted', adopter_id: adopterA.id, pet_id: pets.one });
    expect(response.body.application.risk_flags).toContainEqual(expect.objectContaining({ code: 'first_time_high_needs' }));
    const list = await adopterA.agent.get('/api/applications/mine');
    expect(list.status).toBe(200);
    expect(list.body.items.map(item => item.id)).toContain(response.body.application.id);
  });

  it('validates submission and blocks unauthenticated or invalid applications', async () => {
    expect((await request(app).post('/api/applications').send({})).status).toBe(401);
    expect((await request(app).get('/api/applications/mine')).status).toBe(401);
    expect((await request(app).get('/api/applications/shelter')).status).toBe(401);
    expect((await adopterA.agent.post('/api/applications').send({ petId: 'bad' })).status).toBe(400);
    const removed = await world.pet({ status: 'removed' });
    const response = await submit(adopterA.agent, removed);
    expect(response.status).toBe(404);
    expect((await submit(adopterA.agent, pets.unverifiedShelter)).status).toBe(422);
  });

  it('enforces application ownership while allowing admin detail reads only', async () => {
    const created = await submit(adopterA.agent, pets.two);
    expect((await request(app).get(`/api/applications/${created.body.application.id}`)).status).toBe(401);
    expect((await adopterB.agent.get(`/api/applications/${created.body.application.id}`)).status).toBe(403);
    expect((await otherShelterAgent.get(`/api/applications/${created.body.application.id}`)).status).toBe(403);
    expect((await otherShelterAgent.patch(`/api/applications/${created.body.application.id}/status`).send({ to: 'under_review' })).status).toBe(403);
    const adminRead = await request(app).get(`/api/applications/${created.body.application.id}`).set('Cookie', adminCookie);
    expect(adminRead.status).toBe(200);
    expect(adminRead.body.application.applicant.id).toBe(adopterA.id);
    expect((await request(app).patch(`/api/applications/${created.body.application.id}/status`).set('Cookie', adminCookie).send({ to: 'under_review' })).status).toBe(403);
    const hidden = await submit(adopterA.agent, pets.otherShelter);
    expect((await shelterAgent.get(`/api/applications/${hidden.body.application.id}`)).status).toBe(403);
  });

  it('starts review with required checks and rejects approval until checks pass', async () => {
    const created = await submit(adopterA.agent, pets.three);
    const id = created.body.application.id;
    expect((await review(id)).status).toBe(200);
    const detail = await adopterA.agent.get(`/api/applications/${id}`);
    expect(detail.body.application.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check_type: 'identity', result: 'pending' }),
      expect.objectContaining({ check_type: 'address', result: 'pending' }),
      expect.objectContaining({ check_type: 'household_agreement', result: 'pending' }),
      expect.objectContaining({ check_type: 'landlord_permission', result: 'not_applicable' }),
    ]));
    const invalidCheck = await shelterAgent.patch(`/api/applications/${id}/checks`).send({ checks: [{ checkType: 'home_check', result: 'not_applicable' }] });
    expect(invalidCheck.status).toBe(422);
    const blocked = await shelterAgent.patch(`/api/applications/${id}/status`).send({ to: 'approved' });
    expect(blocked.status).toBe(422);
    expect((await pool.query('SELECT status FROM applications WHERE id=$1', [id])).rows[0].status).toBe('under_review');
    expect((await pool.query('SELECT status FROM pets WHERE id=$1', [pets.three])).rows[0].status).toBe('available');
    await passChecks(id);
    const approved = await shelterAgent.patch(`/api/applications/${id}/status`).send({ to: 'approved' });
    expect(approved.status).toBe(200);
    expect((await pool.query('SELECT status FROM pets WHERE id=$1', [pets.three])).rows[0].status).toBe('pending');
  });

  it('requires renter permission and accepts either a home check or interview', async () => {
    const created = await submit(adopterB.agent, pets.four, { ownership: 'rent', homeType: 'apartment' });
    const id = created.body.application.id;
    await review(id);
    await passChecks(id, shelterAgent, { renter: false, route: 'interview' });
    expect((await shelterAgent.patch(`/api/applications/${id}/status`).send({ to: 'approved' })).status).toBe(422);
    const permission = await shelterAgent.patch(`/api/applications/${id}/checks`).send({ checks: [{ checkType: 'landlord_permission', result: 'passed' }] });
    expect(permission.status).toBe(200);
    expect((await shelterAgent.patch(`/api/applications/${id}/status`).send({ to: 'approved' })).status).toBe(200);
  });

  it('requires rejection notes and restores a pending pet when its approved application is rejected', async () => {
    const created = await submit(adopterA.agent, pets.one);
    const id = created.body.application.id;
    await review(id);
    await passChecks(id);
    expect((await shelterAgent.patch(`/api/applications/${id}/status`).send({ to: 'approved' })).status).toBe(200);
    expect((await shelterAgent.patch(`/api/applications/${id}/status`).send({ to: 'rejected', note: '  ' })).status).toBe(400);
    const rejected = await shelterAgent.patch(`/api/applications/${id}/status`).send({ to: 'rejected', note: 'The home plan needs clarification.' });
    expect(rejected.status).toBe(200);
    expect((await pool.query('SELECT status FROM pets WHERE id=$1', [pets.one])).rows[0].status).toBe('available');
  });

  it('allows at most three simultaneous open applications for one adopter', async () => {
    const results = await Promise.all([pets.one, pets.two, pets.three, pets.four].map(petId => submit(adopterC.agent, petId)));
    expect(results.filter(result => result.status === 201)).toHaveLength(3);
    expect(results.filter(result => result.status === 409 && result.body.error.code === 'TOO_MANY_OPEN_APPLICATIONS')).toHaveLength(1);
  });

  it('serializes two approvals for the same pet so exactly one succeeds', async () => {
    const first = await submit(adopterA.agent, pets.otherShelter);
    const second = await submit(adopterB.agent, pets.otherShelter);
    await review(first.body.application.id, otherShelterAgent);
    await review(second.body.application.id, otherShelterAgent);
    await passChecks(first.body.application.id, otherShelterAgent);
    await passChecks(second.body.application.id, otherShelterAgent);
    const responses = await Promise.all([
      otherShelterAgent.patch(`/api/applications/${first.body.application.id}/status`).send({ to: 'approved' }),
      otherShelterAgent.patch(`/api/applications/${second.body.application.id}/status`).send({ to: 'approved' }),
    ]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect(responses.filter(response => response.status === 409)).toHaveLength(1);
  });

  it('completes adoption atomically, rejects other applicants with the exact note, and records events', async () => {
    const first = await submit(adopterA.agent, pets.four);
    const second = await submit(adopterB.agent, pets.four);
    await review(first.body.application.id);
    await review(second.body.application.id);
    await passChecks(first.body.application.id);
    await passChecks(second.body.application.id);
    expect((await shelterAgent.patch(`/api/applications/${first.body.application.id}/status`).send({ to: 'approved' })).status).toBe(200);
    const result = await shelterAgent.patch(`/api/applications/${first.body.application.id}/status`).send({ to: 'completed' });
    expect(result.status).toBe(200);
    expect((await pool.query('SELECT status FROM pets WHERE id=$1', [pets.four])).rows[0].status).toBe('adopted');
    const other = await adopterB.agent.get(`/api/applications/${second.body.application.id}`);
    expect(other.body.application).toMatchObject({ status: 'rejected', decision_note: 'Pet adopted by another applicant' });
    expect(other.body.application.events).toContainEqual(expect.objectContaining({ to_status: 'rejected', note: 'Pet adopted by another applicant' }));
    expect(result.body.application.completed_at).toBeTruthy();
  });

  it('returns shelter queues and formula-safe adoption CSV', async () => {
    const created = await submit(adopterA.agent, pets.two, { applicantName: '=SUM(A1:A2)' });
    const list = await shelterAgent.get('/api/applications/shelter?q=Application%20pet');
    expect(list.status).toBe(200);
    expect(list.body.statusCounts).toBeDefined();
    await review(created.body.application.id);
    await passChecks(created.body.application.id);
    expect((await shelterAgent.patch(`/api/applications/${created.body.application.id}/status`).send({ to: 'approved' })).status).toBe(200);
    expect((await shelterAgent.patch(`/api/applications/${created.body.application.id}/status`).send({ to: 'completed' })).status).toBe(200);
    const csv = await shelterAgent.get('/api/shelter/adoption-records.csv');
    const records = await shelterAgent.get('/api/shelter/adoption-records');
    const summary = await shelterAgent.get('/api/shelter/summary');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("'=SUM(A1:A2)");
    expect(records.status).toBe(200);
    expect(records.body.stats.completedThisYear).toBeGreaterThanOrEqual(0);
    expect(summary.status).toBe(200);
    expect((await request(app).get('/api/shelter/summary')).status).toBe(401);
    expect(created.status).toBe(201);
  });
});
