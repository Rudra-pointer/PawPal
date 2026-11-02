import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { pool } from '../db/pool.js';
import { matchAnswersSchema } from '../schemas/matching.js';
import { buildPetPairs, canPairPets, getMatchFits, MATCH_WEIGHTS, rankPets, scorePair } from '../services/matching.js';
import { createPetWorld, newFixtureIdentity } from './helpers/petFixtures.js';

const answers = {
  activity: 'low', home: 'apartment', kids: 'no', otherPets: 'none', experience: 'first',
  species: 'any', age: 'any', size: 'any', includePairs: false,
};
const makePet = (overrides = {}) => ({
  id: randomUUID(), name: 'Pip', species: 'dog', status: 'available', shelterActive: true,
  shelterId: 'same-shelter', ageGroup: 'young', size: 'small', energyLevel: 'low',
  houseTrained: true, specialNeeds: false, goodWithChildren: 'unknown',
  goodWithDogs: 'unknown', goodWithCats: 'unknown', temperament: ['calm'],
  createdAt: '2026-01-01T00:00:00Z', ...overrides,
});

describe('smart match scoring (pure fixtures)', () => {
  it('uses weights that total exactly 100', () => {
    expect(Object.values(MATCH_WEIGHTS).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('ranks a calm, small, house-trained pet ahead of a difficult high-energy dog', () => {
    const pets = [
      makePet({ id: 'difficult', size: 'large', energyLevel: 'high', houseTrained: false }),
      makePet({ id: 'calm', size: 'small', energyLevel: 'low', houseTrained: true }),
    ];
    const ranked = rankPets(pets, answers).items;
    expect(ranked.map(pet => pet.id)).toEqual(['calm', 'difficult']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('gives three household personas sensible and different leading matches', () => {
    const pets = [
      makePet({ id: 'calm-cat', species: 'cat', size: 'small', energyLevel: 'low', houseTrained: true }),
      makePet({ id: 'trail-dog', species: 'dog', size: 'large', energyLevel: 'high', houseTrained: true, goodWithChildren: 'yes' }),
      makePet({ id: 'family-dog', species: 'dog', size: 'medium', energyLevel: 'medium', houseTrained: true, goodWithChildren: 'yes' }),
      makePet({ id: 'unsafe-dog', species: 'dog', size: 'medium', energyLevel: 'medium', goodWithChildren: 'no' }),
    ];
    const first = rankPets(pets, answers);
    const runner = rankPets(pets, { ...answers, activity: 'high', home: 'house', experience: 'expert' });
    const family = rankPets(pets, { ...answers, activity: 'medium', home: 'house', kids: 'yes', experience: 'some' });
    expect(first.items[0].id).toBe('calm-cat');
    expect(runner.items[0].id).toBe('trail-dog');
    expect(runner.items[0].id).not.toBe(first.items[0].id);
    expect(family.items[0].id).toBe('family-dog');
    expect(family.items[0].id).not.toBe(runner.items[0].id);
    expect(family.items.some(pet => pet.id === 'unsafe-dog')).toBe(false);
    expect(family.hiddenPetsCount).toBe(1);
  });

  it('excludes not-good-with-children pets and returns their hidden count', () => {
    const result = rankPets([makePet(), makePet({ id: 'unsafe', goodWithChildren: 'no' })], { ...answers, kids: 'yes' });
    expect(result.items.map(pet => pet.id)).toHaveLength(1);
    expect(result.hiddenPetsCount).toBe(1);
  });

  it('scores unknown household compatibility as one half', () => {
    const fits = getMatchFits(makePet({ goodWithChildren: 'unknown' }), { ...answers, kids: 'yes' });
    expect(fits.household).toBe(0.5);
  });

  it('uses the lowest applicable child and other-pet compatibility value', () => {
    const fits = getMatchFits(makePet({ goodWithChildren: 'yes', goodWithDogs: 'unknown' }), { ...answers, kids: 'yes', otherPets: 'dog' });
    expect(fits.household).toBe(0.5);
  });

  it('uses the household factor of one when there is nothing to assess', () => {
    expect(getMatchFits(makePet(), answers).household).toBe(1);
  });

  it('applies the specified dog apartment size fits', () => {
    expect(getMatchFits(makePet({ size: 'large' }), answers).home).toBe(0.2);
    expect(getMatchFits(makePet({ size: 'small' }), answers).home).toBe(1);
  });

  it('applies experience difficulty, tolerance, and clamping', () => {
    const hardRabbit = makePet({ species: 'dog', specialNeeds: true, energyLevel: 'high', size: 'large', houseTrained: false });
    expect(getMatchFits(hardRabbit, { ...answers, experience: 'first' }).experience).toBe(0);
    expect(getMatchFits(hardRabbit, { ...answers, experience: 'expert' }).experience).toBe(0.5);
  });

  it('scores exact, neighbouring, and distant age preferences', () => {
    const pet = makePet({ ageGroup: 'young' });
    expect(getMatchFits(pet, { ...answers, age: 'young' }).age).toBe(1);
    expect(getMatchFits(pet, { ...answers, age: 'baby' }).age).toBe(0.5);
    expect(getMatchFits(pet, { ...answers, age: 'senior' }).age).toBe(0);
  });

  it('scores exact and neighbouring size preferences', () => {
    expect(getMatchFits(makePet({ size: 'medium' }), { ...answers, size: 'medium' }).size).toBe(1);
    expect(getMatchFits(makePet({ size: 'medium' }), { ...answers, size: 'small' }).size).toBe(0.5);
    expect(getMatchFits(makePet({ size: 'xlarge' }), { ...answers, size: 'small' }).size).toBe(0);
  });

  it('adds friendly reasons for strong fits and cautions for weak fits', () => {
    const strong = rankPets([makePet({ goodWithChildren: 'yes' })], { ...answers, kids: 'yes' }).items[0];
    const weak = rankPets([makePet({ energyLevel: 'high', size: 'large' })], answers).items[0];
    expect(strong.reasons).toContain('Great with kids');
    expect(weak.cautions).toContain('Needs more exercise than you described');
  });

  it('orders by score, then newest date, while preserving exact ties', () => {
    const older = makePet({ id: 'older', createdAt: '2026-01-01T00:00:00Z' });
    const newest = makePet({ id: 'newest', createdAt: '2026-02-01T00:00:00Z' });
    const tieOne = makePet({ id: 'tie-one', createdAt: '2026-03-01T00:00:00Z' });
    const tieTwo = makePet({ id: 'tie-two', createdAt: '2026-03-01T00:00:00Z' });
    expect(rankPets([older, tieOne, tieTwo, newest], answers).items.map(pet => pet.id)).toEqual(['tie-one', 'tie-two', 'newest', 'older']);
  });

  it('keeps only available pets from active shelters and applies species filters', () => {
    const result = rankPets([
      makePet({ id: 'dog' }), makePet({ id: 'cat', species: 'cat' }),
      makePet({ id: 'pending', status: 'pending' }), makePet({ id: 'inactive', shelterActive: false }),
    ], { ...answers, species: 'cat' });
    expect(result.items.map(pet => pet.id)).toEqual(['cat']);
  });

  it('requires same shelter and permits mixed dog-cat pairs only with mutual yes flags', () => {
    const dog = makePet({ species: 'dog', goodWithCats: 'yes' });
    const cat = makePet({ species: 'cat', goodWithDogs: 'yes' });
    expect(canPairPets(dog, cat)).toBe(true);
    expect(canPairPets(dog, { ...cat, goodWithDogs: 'unknown' })).toBe(false);
    expect(canPairPets(dog, { ...cat, shelterId: 'other-shelter' })).toBe(false);
    expect(canPairPets(dog, makePet({ species: 'rabbit' }))).toBe(false);
  });

  it('scores pair compatibility with energy, age, temperament, and size weights', () => {
    const first = makePet();
    const second = makePet({ energyLevel: 'medium', ageGroup: 'adult', size: 'medium', temperament: ['calm', 'gentle'] });
    expect(scorePair(first, second)).toBe(58);
  });

  it('places bonded pairs first and labels them even below the regular threshold', () => {
    const bondedA = makePet({ id: 'bond-a', bondedPetId: 'bond-b', energyLevel: 'low', temperament: [] });
    const bondedB = makePet({ id: 'bond-b', bondedPetId: 'bond-a', energyLevel: 'high', ageGroup: 'senior', size: 'xlarge', temperament: [] });
    const compatibleA = makePet({ id: 'compatible-a' });
    const compatibleB = makePet({ id: 'compatible-b', temperament: ['calm', 'gentle'] });
    const pairs = buildPetPairs([compatibleA, bondedA, compatibleB, bondedB]);
    expect(pairs[0]).toMatchObject({ bonded: true, label: 'Bonded pair: adopt together' });
    expect(pairs.some(pair => pair.pets.some(pet => pet.id === 'bond-a') && pair.score < 70)).toBe(true);
  });

  it('omits unbonded pairs below 70 and does not duplicate a pair', () => {
    const a = makePet({ id: 'a', energyLevel: 'low', ageGroup: 'baby', size: 'small', temperament: [] });
    const b = makePet({ id: 'b', energyLevel: 'high', ageGroup: 'senior', size: 'xlarge', temperament: [] });
    expect(buildPetPairs([a, b])).toEqual([]);
    const good = makePet({ id: 'c' });
    expect(buildPetPairs([a, good, good]).length).toBeLessThanOrEqual(1);
  });

  it('validates the complete seven-answer questionnaire and rejects malformed values', () => {
    expect(matchAnswersSchema.safeParse(answers).success).toBe(true);
    expect(matchAnswersSchema.safeParse({ ...answers, activity: 'extreme' }).success).toBe(false);
    expect(matchAnswersSchema.safeParse({ ...answers, unexpected: true }).success).toBe(false);
  });

  it('ranks 500 pets in under 300 milliseconds', () => {
    const pets = Array.from({ length: 500 }, (_, index) => makePet({ id: String(index), energyLevel: ['low', 'medium', 'high'][index % 3] }));
    const started = performance.now();
    expect(rankPets(pets, answers).items).toHaveLength(12);
    expect(performance.now() - started).toBeLessThan(300);
  });
});

describe('smart match API (pawpal_test fixtures)', () => {
  let world;
  let agent;
  let userId;
  let petIds = {};

  beforeAll(async () => {
    const { rows } = await pool.query('SELECT current_database() AS name');
    if (rows[0]?.name !== 'pawpal_test') throw new Error('Matching integration tests require pawpal_test; no fixture writes were made.');
    world = await createPetWorld(pool);
    petIds.calm = await world.pet({ name: 'Match Calm', species: 'dog', size: 'small', energy: 'low', houseTrained: true, goodChildren: 'yes', temperament: ['calm', 'gentle'] });
    petIds.hard = await world.pet({ name: 'Match Trail', species: 'dog', size: 'large', energy: 'high', houseTrained: false, specialNeeds: true, goodChildren: 'no' });
    petIds.rabbitA = await world.pet({ name: 'Bonded Rabbit A', species: 'rabbit', size: 'small', energy: 'medium', houseTrained: true, temperament: ['calm', 'social'] });
    petIds.rabbitB = await world.pet({ name: 'Bonded Rabbit B', species: 'rabbit', size: 'small', energy: 'medium', houseTrained: true, temperament: ['calm', 'social'] });
    await pool.query('UPDATE pets SET bonded_pet_id=$1 WHERE id=$2', [petIds.rabbitB, petIds.rabbitA]);
    await pool.query('UPDATE pets SET bonded_pet_id=$1 WHERE id=$2', [petIds.rabbitA, petIds.rabbitB]);
    agent = request.agent(app);
    const identity = newFixtureIdentity();
    const registration = await agent.post('/api/auth/register').send({ ...identity, role: 'adopter' });
    expect(registration.status).toBe(201);
    userId = registration.body.user.id;
  });

  afterAll(async () => {
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    if (world) await world.cleanup();
    await pool.end();
  });

  it('returns ranked available matches with scores and reasons', async () => {
    const response = await request(app).post('/api/match').send(answers);
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ id: petIds.calm, score: expect.any(Number) });
    expect(response.body.weights).toEqual(MATCH_WEIGHTS);
  });

  it('rejects invalid answers using the standard validation error shape', async () => {
    const response = await request(app).post('/api/match').send({ ...answers, activity: 'extreme' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.any(String), details: expect.any(Array) });
  });

  it('returns bonded pairs before normal pairs and the rabbit social note', async () => {
    const response = await request(app).post('/api/match/pairs').send({ ...answers, species: 'rabbit', includePairs: true });
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ bonded: true, label: 'Bonded pair: adopt together' });
    expect(response.body.items[0].pets.map(pet => pet.id)).toEqual(expect.arrayContaining([petIds.rabbitA, petIds.rabbitB]));
    expect(response.body.note).toBe('Rabbits are social animals and usually do best in pairs');
  });

  it('rejects malformed pairing answers', async () => {
    const response = await request(app).post('/api/match/pairs').send({ ...answers, home: 'tent' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires an authenticated account to read the last match', async () => {
    const response = await request(app).get('/api/match/last');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('stores a logged-in match run and returns only that user’s last run', async () => {
    const run = await agent.post('/api/match').send(answers);
    expect(run.status).toBe(200);
    const response = await agent.get('/api/match/last');
    expect(response.status).toBe(200);
    expect(response.body.item).toMatchObject({ answers, topPetIds: expect.arrayContaining([petIds.calm]) });
    expect(response.body.item.results.items[0].id).toBe(petIds.calm);
  });
});
