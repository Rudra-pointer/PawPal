import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireRole } from './auth.js';
import { savedPetsQuerySchema, uuidParamSchema, validationError } from '../schemas/petDiscovery.js';
import { toAgeLabel } from '../services/petDiscovery.js';

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
export const savedPetsRouter = Router();
savedPetsRouter.use(...requireRole('adopter'));

savedPetsRouter.post('/:petId', asyncRoute(async (req, res) => {
  const parsedId = uuidParamSchema.safeParse(req.params.petId);
  if (!parsedId.success) return validationError(res, 'Enter a valid pet ID.');
  const { rows } = await query(`
    INSERT INTO saved_pets (user_id, pet_id)
    SELECT $1, p.id
    FROM pets p
    JOIN shelters s ON s.id = p.shelter_id AND s.verification_status = 'verified'
    JOIN users u ON u.id = s.owner_user_id AND u.status = 'active'
    WHERE p.id = $2 AND p.status <> 'removed'
    ON CONFLICT (user_id, pet_id) DO NOTHING
    RETURNING user_id, pet_id, created_at
  `, [req.user.id, parsedId.data]);
  if (rows.length) return res.status(201).json({ saved: true, petId: rows[0].pet_id, createdAt: rows[0].created_at });
  const existing = await query('SELECT 1 FROM saved_pets WHERE user_id=$1 AND pet_id=$2', [req.user.id, parsedId.data]);
  if (existing.rows.length) return res.json({ saved: true, petId: parsedId.data });
  return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This pet is no longer available to save.', details: [] } });
}));

savedPetsRouter.delete('/:petId', asyncRoute(async (req, res) => {
  const parsedId = uuidParamSchema.safeParse(req.params.petId);
  if (!parsedId.success) return validationError(res, 'Enter a valid pet ID.');
  await query('DELETE FROM saved_pets WHERE user_id=$1 AND pet_id=$2', [req.user.id, parsedId.data]);
  res.json({ saved: false, petId: parsedId.data });
}));

savedPetsRouter.get('/', asyncRoute(async (req, res) => {
  const parsed = savedPetsQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, 'Check the saved-pets pagination values.', parsed.error.issues);
  const { page, pageSize } = parsed.data;
  const { rows } = await query(`
    WITH visible AS MATERIALIZED (
      SELECT p.id, p.name, p.species::text AS species, p.breed, p.age_months,
             p.age_group::text AS age_group, p.gender::text AS gender,
             p.size::text AS size, p.status::text AS status, s.city, s.state,
             sp.created_at AS saved_at,
             count(*) OVER()::int AS total
      FROM saved_pets sp
      JOIN pets p ON p.id=sp.pet_id AND p.status <> 'removed'
      JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
      JOIN users u ON u.id=s.owner_user_id AND u.status='active'
      WHERE sp.user_id=$1
    ), page_rows AS (
      SELECT * FROM visible ORDER BY saved_at DESC,id LIMIT $2 OFFSET $3
    ), total_rows AS (SELECT count(*)::int AS total FROM visible)
    SELECT page_rows.*, coalesce(page_rows.total,total_rows.total) AS result_total,
           photo.id AS photo_id,
           CASE WHEN photo.url IS NOT NULL THEN photo.url
                WHEN photo.id IS NOT NULL THEN '/api/photos/' || photo.id::text
                ELSE NULL END AS primary_photo
    FROM total_rows LEFT JOIN page_rows ON TRUE
    LEFT JOIN LATERAL (SELECT id,url FROM pet_photos WHERE pet_id=page_rows.id
                       ORDER BY is_primary DESC,position,id LIMIT 1) photo ON TRUE
    ORDER BY page_rows.saved_at DESC,page_rows.id
  `, [req.user.id, pageSize, (page - 1) * pageSize]);
  const total = rows[0]?.result_total ?? 0;
  const items = rows.filter(row => row.id).map(row => ({
    id: row.id, name: row.name, species: row.species, breed: row.breed,
    ageLabel: toAgeLabel(row.age_months), ageGroup: row.age_group,
    gender: row.gender, size: row.size, city: row.city, state: row.state,
    status: row.status, primaryPhoto: row.primary_photo, savedAt: row.saved_at,
  }));
  res.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
}));
