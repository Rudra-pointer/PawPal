import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, optionalAuth } from './auth.js';
import { matchAnswersSchema } from '../schemas/matching.js';
import { MATCH_WEIGHTS, rankPets, buildPetPairs } from '../services/matching.js';

export const matchingRouter = Router();
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MATCHABLE_PETS_SQL = `
  SELECT p.id, p.name, p.species::text AS species, p.breed, p.age_months,
         p.age_group::text AS age_group, p.gender::text AS gender, p.size::text AS size,
         p.energy_level::text AS energy_level, p.house_trained, p.special_needs,
         p.good_with_children::text AS good_with_children,
         p.good_with_dogs::text AS good_with_dogs, p.good_with_cats::text AS good_with_cats,
         p.temperament, p.bonded_pet_id, p.created_at, p.shelter_id,
         s.city, s.state,
         CASE WHEN photo.url IS NOT NULL THEN photo.url
              WHEN photo.id IS NOT NULL THEN '/api/photos/' || photo.id::text
              ELSE NULL END AS photo
  FROM pets p
  JOIN shelters s ON s.id = p.shelter_id AND s.verification_status = 'verified'
  JOIN users u ON u.id = s.owner_user_id AND u.status = 'active'
  LEFT JOIN LATERAL (
    SELECT id, url FROM pet_photos WHERE pet_id = p.id
    ORDER BY is_primary DESC, position ASC, id ASC LIMIT 1
  ) photo ON TRUE
  WHERE p.status = 'available'
  ORDER BY p.created_at DESC, p.id
`;

function errorResponse(res, issues) {
  return res.status(400).json({ error: {
    code: 'VALIDATION_ERROR',
    message: 'Please check your matching answers.',
    details: issues,
  } });
}

function mapPet(row) {
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    breed: row.breed,
    ageMonths: row.age_months,
    ageGroup: row.age_group,
    gender: row.gender,
    size: row.size,
    energyLevel: row.energy_level,
    houseTrained: row.house_trained,
    specialNeeds: row.special_needs,
    goodWithChildren: row.good_with_children,
    goodWithDogs: row.good_with_dogs,
    goodWithCats: row.good_with_cats,
    temperament: row.temperament,
    bondedPetId: row.bonded_pet_id,
    createdAt: row.created_at,
    shelterId: row.shelter_id,
    shelterActive: true,
    status: 'available',
    city: row.city,
    state: row.state,
    photo: row.photo,
  };
}

async function loadPets() {
  const { rows } = await query(MATCHABLE_PETS_SQL);
  return rows.map(mapPet);
}

async function saveRun(userId, answers, matches) {
  if (!userId) return;
  await query(
    'INSERT INTO match_runs (user_id, answers, top_pet_ids) VALUES ($1, $2::jsonb, $3::uuid[])',
    [userId, JSON.stringify(answers), matches.map(pet => pet.id)],
  );
}

matchingRouter.post('/', optionalAuth, asyncHandler(async (req, res) => {
  const parsed = matchAnswersSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, parsed.error.issues);
  const answers = parsed.data;
  const matches = rankPets(await loadPets(), answers);
  await saveRun(req.user?.id, answers, matches.items);
  res.json({ ...matches, weights: MATCH_WEIGHTS });
}));

matchingRouter.post('/pairs', optionalAuth, asyncHandler(async (req, res) => {
  const parsed = matchAnswersSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, parsed.error.issues);
  const answers = parsed.data;
  const ranked = rankPets(await loadPets(), answers, 30);
  const items = buildPetPairs(ranked.items);
  await saveRun(req.user?.id, answers, ranked.items);
  const hasRabbit = ranked.items.some(pet => pet.species === 'rabbit')
    || items.some(pair => pair.pets.some(pet => pet.species === 'rabbit'));
  res.json({ items, note: hasRabbit ? 'Rabbits are social animals and usually do best in pairs' : null });
}));

matchingRouter.get('/last', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT id, answers, top_pet_ids, created_at FROM match_runs WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [req.user.id],
  );
  const run = rows[0];
  const results = run ? rankPets(await loadPets(), run.answers) : null;
  if (results && run.top_pet_ids?.length) {
    const savedIds = new Set(run.top_pet_ids.map(String));
    results.items = results.items.filter(pet => savedIds.has(String(pet.id)));
  }
  res.json({ item: run ? {
    id: run.id,
    answers: run.answers,
    topPetIds: run.top_pet_ids,
    createdAt: run.created_at,
    results,
  } : null });
}));
