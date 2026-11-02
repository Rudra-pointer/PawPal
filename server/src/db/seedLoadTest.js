import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from './pool.js';
import { browsePetsSql } from '../services/petDiscovery.js';
import { env } from '../config/env.js';

if (env.NODE_ENV !== 'test' || !env.TEST_DATABASE_URL) {
  throw new Error('The browse load test requires NODE_ENV=test and TEST_DATABASE_URL.');
}

const temporary = randomUUID().replaceAll('-', '').slice(0, 20);
const petIds = [];
let userId;
let shelterId;
let testDatabaseConfirmed = false;

const browseValues = [null, null, null, null, null, null, 'available', null, null, 'newest', 24, 0];

async function assertTestDatabase() {
  const { rows } = await pool.query('SELECT current_database() AS name');
  if (rows[0]?.name !== 'pawpal_test') {
    throw new Error('Load-test writes are permitted only when current_database() is pawpal_test.');
  }
  testDatabaseConfirmed = true;
  console.log('Database identity verified: pawpal_test');
}

async function createBenchmarkRows() {
  const users = await pool.query(`
    INSERT INTO users (user_code,name,email,password_hash,role,status,city,state)
    VALUES ($1,$2,$3,$4,'shelter','active','PawPal Benchmark','ZZ') RETURNING id
  `, [`load_${temporary}`, `Load Test ${temporary}`, `load_${temporary}@pawpal.test`, 'benchmark-fixture-hash']);
  userId = users.rows[0].id;
  const shelters = await pool.query(`
    INSERT INTO shelters (owner_user_id,name,address_line,city,state,contact_email,verification_status)
    VALUES ($1,$2,$3,$4,$5,$6,'verified') RETURNING id
  `, [userId, `Load Test Shelter ${temporary}`, '1 Benchmark Way', 'PawPal Benchmark', 'ZZ', `contact_${temporary}@pawpal.test`]);
  shelterId = shelters.rows[0].id;
  for (let index = 1; index <= 500; index += 1) {
    const { rows } = await pool.query(`
      INSERT INTO pets (shelter_id,name,species,breed,age_months,gender,size,energy_level,status,description,source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'available',$9,'local') RETURNING id
    `, [shelterId, `Benchmark Pet ${temporary}-${index}`, index % 3 === 0 ? 'cat' : 'dog', `Benchmark Breed ${index % 20}`, 12 + (index % 120), index % 2 ? 'female' : 'male', index % 2 ? 'small' : 'medium', index % 2 ? 'low' : 'medium', `Temporary browse benchmark record ${temporary} ${index}`]);
    petIds.push(rows[0].id);
  }
  await pool.query('ANALYZE pets');
  console.log(`Created exactly ${petIds.length} temporary pets in pawpal_test.`);
}

async function measureBrowse() {
  const timings = [];
  for (let run = 1; run <= 7; run += 1) {
    const start = performance.now();
    const response = await request(app).get('/api/pets?pageSize=24&sort=newest');
    timings.push(performance.now() - start);
    if (response.status !== 200) throw new Error(`Browse request ${run} failed with HTTP ${response.status}.`);
    if (response.body.total < 500) throw new Error(`Browse request saw only ${response.body.total} pets; expected the 500 temporary pets.`);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const explain = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${browsePetsSql}`, browseValues);
  const plan = explain.rows[0]['QUERY PLAN'][0];
  const summary = {
    database: 'pawpal_test',
    temporaryPets: petIds.length,
    browseRouteRuns: timings.length,
    browseRouteMilliseconds: timings.map(value => Number(value.toFixed(2))),
    medianBrowseRouteMilliseconds: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    explainExecutionMilliseconds: Number(plan['Execution Time'].toFixed(3)),
    explainPlanningMilliseconds: Number(plan['Planning Time'].toFixed(3)),
    explainPlan: plan.Plan,
  };
  console.log('Browse route timing and EXPLAIN summary:');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function cleanupExactRows() {
  if (!testDatabaseConfirmed) return;
  if (petIds.length) await pool.query('DELETE FROM pets WHERE id=ANY($1::uuid[])', [petIds]);
  if (shelterId) await pool.query('DELETE FROM shelters WHERE id=$1', [shelterId]);
  if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  const remaining = await pool.query('SELECT count(*)::int AS count FROM pets WHERE id=ANY($1::uuid[])', [petIds]);
  if (remaining.rows[0].count !== 0) throw new Error('Temporary benchmark pets remained after exact-ID cleanup.');
  console.log(`Cleaned up only the ${petIds.length} temporary pet IDs and their benchmark shelter/user.`);
}

try {
  await assertTestDatabase();
  await createBenchmarkRows();
  await measureBrowse();
} catch (error) {
  console.error(`Load test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    await cleanupExactRows();
  } catch (error) {
    console.error(`Exact benchmark cleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
  await pool.end();
}
