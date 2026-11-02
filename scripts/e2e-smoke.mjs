import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { app } from '../server/src/app.js';
import { pool } from '../server/src/db/pool.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.NODE_ENV !== 'test' || !databaseUrl || new URL(databaseUrl).pathname !== '/pawpal_test') {
  throw new Error('The smoke test requires NODE_ENV=test and TEST_DATABASE_URL pointing to pawpal_test.');
}

const identity = await pool.query('SELECT current_database() AS database_name');
if (identity.rows[0]?.database_name !== 'pawpal_test') throw new Error('Smoke-test writes are permitted only in pawpal_test.');
console.log('Smoke-test database verified: pawpal_test');

const fixtureKey = randomUUID().replaceAll('-', '').slice(0, 18);
const userIds = [];
const petIds = [];
const shelterIds = [];
const applicationIds = [];
const reportIds = [];
let server;
let baseUrl;

async function call(path, { method = 'GET', cookie, body, form } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  const nextCookie = response.headers.get('set-cookie')?.split(';', 1)[0] || cookie;
  return { response, data, cookie: nextCookie };
}

async function expectStatus(result, expected, action) {
  assert.equal(result.response.status, expected, `${action}: ${JSON.stringify(result.data.error || result.data)}`);
}

async function register({ name, userCode, email, role }) {
  const result = await call('/api/auth/register', { method: 'POST', body: { name, userCode, email, password: 'SmokeTest123', role } });
  await expectStatus(result, 201, `register ${role}`);
  userIds.push(result.data.user.id);
  return { user: result.data.user, cookie: result.cookie };
}

async function registerShelter(ownerCookie, title) {
  const form = new FormData();
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  form.append('name', title);
  form.append('description', 'Temporary end-to-end smoke-test shelter.');
  form.append('addressLine', '1 PawPal Test Way');
  form.append('city', 'Testville');
  form.append('state', 'CA');
  form.append('country', 'US');
  form.append('contactEmail', `contact-${fixtureKey}-${shelterIds.length}@pawpal.test`);
  form.append('documents', new Blob([pdf], { type: 'application/pdf' }), 'proof.pdf');
  const result = await call('/api/shelters', { method: 'POST', cookie: ownerCookie, form });
  await expectStatus(result, 201, 'register shelter');
  shelterIds.push(result.data.shelter.id);
  return result.data.shelter;
}

async function cleanup() {
  if (reportIds.length) await pool.query('DELETE FROM reports WHERE id=ANY($1::uuid[])', [reportIds]);
  if (userIds.length) await pool.query('DELETE FROM reports WHERE reporter_id=ANY($1::uuid[])', [userIds]);
  if (userIds.length) await pool.query('DELETE FROM audit_log WHERE actor_id=ANY($1::uuid[])', [userIds]);
  if (userIds.length) await pool.query('DELETE FROM match_runs WHERE user_id=ANY($1::uuid[])', [userIds]);
  if (userIds.length) await pool.query('DELETE FROM saved_pets WHERE user_id=ANY($1::uuid[])', [userIds]);
  if (applicationIds.length) await pool.query('DELETE FROM application_events WHERE application_id=ANY($1::uuid[])', [applicationIds]);
  if (applicationIds.length) await pool.query('DELETE FROM application_checks WHERE application_id=ANY($1::uuid[])', [applicationIds]);
  if (applicationIds.length) await pool.query('DELETE FROM applications WHERE id=ANY($1::uuid[])', [applicationIds]);
  if (shelterIds.length) await pool.query('DELETE FROM shelter_documents WHERE shelter_id=ANY($1::uuid[])', [shelterIds]);
  if (petIds.length) await pool.query('DELETE FROM pet_photos WHERE pet_id=ANY($1::uuid[])', [petIds]);
  if (petIds.length) await pool.query('DELETE FROM pet_vaccinations WHERE pet_id=ANY($1::uuid[])', [petIds]);
  if (petIds.length) await pool.query('UPDATE pets SET bonded_pet_id=NULL WHERE id=ANY($1::uuid[])', [petIds]);
  if (petIds.length) await pool.query('DELETE FROM pets WHERE id=ANY($1::uuid[])', [petIds]);
  if (shelterIds.length) await pool.query('DELETE FROM shelters WHERE id=ANY($1::uuid[])', [shelterIds]);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function verifyProductionServer() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/src/server.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: 'postgres://unused:unused@ep-static-smoke.invalid.neon.tech/not_used_by_static_smoke?sslmode=verify-full',
      JWT_SECRET: 'production-smoke-only-random-secret-value-over-32',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: 'true',
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    let response;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Production server exited before listening (${child.exitCode}). ${stderr}`);
      try { response = await fetch(`${origin}/browse`); if (response.ok) break; } catch { /* server is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert(response?.ok, `Production server did not serve /browse. ${stderr}`);
    const html = await response.text();
    assert.match(html, /id="root"/);
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

    const script = html.match(/src="([^"]+\.js)"/i)?.[1];
    assert(script, 'Built client entry script was not found in the served HTML.');
    const asset = await fetch(new URL(script, origin), { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control') || '', /max-age=31536000.*immutable/);
    assert.equal(asset.headers.get('content-encoding'), 'gzip');

    const deepLink = await fetch(`${origin}/shelter/applications/example-id`);
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /id="root"/);
    const unknownApi = await fetch(`${origin}/api/not-an-endpoint`);
    assert.equal(unknownApi.status, 404);
    assert.equal((await unknownApi.json()).error.code, 'NOT_FOUND');
    console.log('Production-server smoke passed: SPA/deep-route fallback, Helmet headers, hashed-asset cache, gzip, and JSON API 404.');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  }
}

try {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const adopter = await register({ name: 'Smoke Adopter', userCode: `smoke_a_${fixtureKey}`, email: `smoke-a-${fixtureKey}@pawpal.test`, role: 'adopter' });
  const login = await call('/api/auth/login', { method: 'POST', body: { identifier: adopter.user.email, password: 'SmokeTest123' } });
  await expectStatus(login, 200, 'login adopter');
  const adopterCookie = login.cookie;

  const shelterOwner = await register({ name: 'Smoke Shelter Owner', userCode: `smoke_s_${fixtureKey}`, email: `smoke-s-${fixtureKey}@pawpal.test`, role: 'shelter' });
  const shelter = await registerShelter(shelterOwner.cookie, `Smoke Shelter ${fixtureKey}`);

  const adminCode = `smoke_admin_${fixtureKey}`;
  const adminEmail = `smoke-admin-${fixtureKey}@pawpal.test`;
  const passwordHash = await bcrypt.hash('SmokeTest123', 10);
  const adminResult = await pool.query(
    "INSERT INTO users (user_code,name,email,password_hash,role,status) VALUES ($1,$2,$3,$4,'admin','active') RETURNING id",
    [adminCode, 'Smoke Admin', adminEmail, passwordHash],
  );
  const adminId = adminResult.rows[0].id;
  userIds.push(adminId);
  const adminLogin = await call('/api/auth/login', { method: 'POST', body: { identifier: adminCode, password: 'SmokeTest123' } });
  await expectStatus(adminLogin, 200, 'login admin');
  const adminCookie = adminLogin.cookie;

  let result = await call(`/api/admin/shelters/${shelter.id}/verification`, { method: 'PATCH', cookie: adminCookie, body: { action: 'verify' } });
  await expectStatus(result, 200, 'verify shelter');
  assert.equal(result.data.shelter.verification_status, 'verified');

  result = await call('/api/shelter/pets', { method: 'POST', cookie: shelterOwner.cookie, body: {
    name: `Smoke Pet ${fixtureKey}`, species: 'dog', breed: 'Mixed breed', ageMonths: 18, gender: 'unknown', size: 'medium',
    colors: [], description: 'Temporary smoke-test listing.', temperament: ['gentle'], energyLevel: 'medium',
    spayedNeutered: true, microchipped: false, houseTrained: true, specialNeeds: false,
    goodWithChildren: 'yes', goodWithDogs: 'unknown', goodWithCats: 'unknown',
  } });
  await expectStatus(result, 201, 'create smoke pet');
  const petId = result.data.pet.id;
  petIds.push(petId);

  result = await call('/api/pets?species=dog&status=available&pageSize=12');
  await expectStatus(result, 200, 'browse and filter');
  assert(result.data.items.some(pet => pet.id === petId));
  result = await call(`/api/me/saved/${petId}`, { method: 'POST', cookie: adopterCookie });
  await expectStatus(result, 201, 'save pet');

  const answers = { activity: 'medium', home: 'house', kids: 'no', otherPets: 'none', experience: 'some', species: 'dog', age: 'any', size: 'any', includePairs: false };
  result = await call('/api/match', { method: 'POST', cookie: adopterCookie, body: answers });
  await expectStatus(result, 200, 'match quiz');
  assert(Array.isArray(result.data.items));

  result = await call('/api/applications', { method: 'POST', cookie: adopterCookie, body: {
    petId, applicantName: 'Smoke Adopter', applicantEmail: `smoke-a-${fixtureKey}@pawpal.test`, contactNo: '555-0100',
    addressLine: '2 PawPal Test Way', city: 'Testville', state: 'CA', homeType: 'house_with_yard', ownership: 'own',
    householdAdults: 1, hasChildren: false, youngestChildAge: null, otherPets: '', experience: 'some', hoursAlonePerDay: 4,
    reason: 'This is a sufficiently detailed smoke-test adoption reason.',
  } });
  await expectStatus(result, 201, 'submit application');
  const applicationId = result.data.application.id;
  applicationIds.push(applicationId);

  result = await call(`/api/applications/${applicationId}/status`, { method: 'PATCH', cookie: shelterOwner.cookie, body: { to: 'under_review' } });
  await expectStatus(result, 200, 'start application review');
  result = await call(`/api/applications/${applicationId}/checks`, { method: 'PATCH', cookie: shelterOwner.cookie, body: { checks: [
    { checkType: 'identity', result: 'passed' }, { checkType: 'address', result: 'passed' },
    { checkType: 'household_agreement', result: 'passed' }, { checkType: 'landlord_permission', result: 'not_applicable' },
    { checkType: 'home_check', result: 'passed' },
  ] } });
  await expectStatus(result, 200, 'complete required checks');
  result = await call(`/api/applications/${applicationId}/status`, { method: 'PATCH', cookie: shelterOwner.cookie, body: { to: 'approved' } });
  await expectStatus(result, 200, 'approve application');
  result = await call(`/api/applications/${applicationId}/status`, { method: 'PATCH', cookie: shelterOwner.cookie, body: { to: 'completed' } });
  await expectStatus(result, 200, 'complete adoption');

  const secondOwner = await register({ name: 'Smoke New Shelter Owner', userCode: `smoke_n_${fixtureKey}`, email: `smoke-n-${fixtureKey}@pawpal.test`, role: 'shelter' });
  const secondShelter = await registerShelter(secondOwner.cookie, `Smoke New Shelter ${fixtureKey}`);
  result = await call(`/api/admin/shelters/${secondShelter.id}/verification`, { method: 'PATCH', cookie: adminCookie, body: { action: 'verify' } });
  await expectStatus(result, 200, 'verify newly registered shelter');

  result = await call('/api/reports', { method: 'POST', cookie: adopterCookie, body: { targetType: 'pet', targetId: petId, reason: 'other', details: 'Temporary smoke-test report.' } });
  await expectStatus(result, 201, 'report listing');
  const reportId = result.data.report.id;
  reportIds.push(reportId);
  result = await call(`/api/admin/reports/${reportId}`, { method: 'PATCH', cookie: adminCookie, body: { action: 'dismiss', note: 'Smoke-test report reviewed.' } });
  await expectStatus(result, 200, 'resolve report');

  await verifyProductionServer();
  console.log('Smoke story passed: adopter registration/login, filtered browse, save, matching, application review/approval/completion, shelter registration/verification, report and admin resolution.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  try {
    const check = await pool.query('SELECT current_database() AS database_name');
    if (check.rows[0]?.database_name !== 'pawpal_test') throw new Error('Refusing fixture cleanup outside pawpal_test.');
    await cleanup();
    console.log('Smoke-test cleanup completed for its tracked fixtures only.');
  } finally {
    await pool.end();
  }
}
