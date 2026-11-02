import { Router } from 'express';
import { query } from '../db/pool.js';

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
export const metaRouter = Router();

metaRouter.get('/filters', asyncRoute(async (_req, res) => {
  const [speciesResult, breedResult, cityResult, sizeResult, ageResult] = await Promise.all([
    query(`SELECT p.species, count(*)::int AS count
           FROM pets p JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
           JOIN users u ON u.id=s.owner_user_id AND u.status='active'
           WHERE p.status = 'available' GROUP BY p.species ORDER BY p.species`),
    query(`SELECT p.species::text AS species, p.breed, count(*)::int AS count
           FROM pets p JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
           JOIN users u ON u.id=s.owner_user_id AND u.status='active'
           WHERE p.status='available' GROUP BY p.species,p.breed ORDER BY p.species,lower(p.breed)`),
    query(`SELECT s.city, s.state, count(*)::int AS count
           FROM pets p JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
           JOIN users u ON u.id=s.owner_user_id AND u.status='active'
           WHERE p.status='available' GROUP BY s.city,s.state ORDER BY lower(s.city),s.state`),
    query(`SELECT unnest(enum_range(NULL::size_type))::text AS value`),
    query(`SELECT unnest(enum_range(NULL::age_group_type))::text AS value`),
  ]);
  res.json({
    species: speciesResult.rows,
    breeds: breedResult.rows,
    cities: cityResult.rows,
    sizes: sizeResult.rows.map(row => row.value),
    ageGroups: ageResult.rows.map(row => row.value),
  });
}));
