import { Router } from 'express';
import { query } from '../db/pool.js';
import { uuidParamSchema, validationError } from '../schemas/petDiscovery.js';

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
export const photosRouter = Router();

photosRouter.get('/:id', asyncRoute(async (req, res) => {
  const parsedId = uuidParamSchema.safeParse(req.params.id);
  if (!parsedId.success) return validationError(res, 'Enter a valid photo ID.');
  const { rows } = await query(`
    SELECT ph.url, ph.data, ph.mime_type
    FROM pet_photos ph
    JOIN pets p ON p.id=ph.pet_id AND p.status <> 'removed'
    JOIN shelters s ON s.id=p.shelter_id AND s.verification_status='verified'
    JOIN users u ON u.id=s.owner_user_id AND u.status='active'
    WHERE ph.id=$1
  `, [parsedId.data]);
  const photo = rows[0];
  if (!photo) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This photo could not be found.', details: [] } });
  if (photo.url) {
    let target;
    try { target = new URL(photo.url); } catch {
      return res.status(500).json({ error: { code: 'INVALID_PHOTO_URL', message: 'This photo is temporarily unavailable.', details: [] } });
    }
    if (!['https:', 'http:'].includes(target.protocol)) {
      return res.status(500).json({ error: { code: 'INVALID_PHOTO_URL', message: 'This photo is temporarily unavailable.', details: [] } });
    }
    return res.redirect(302, target.href);
  }
  if (!photo.data) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This photo could not be found.', details: [] } });
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Content-Type', photo.mime_type || 'application/octet-stream');
  res.send(photo.data);
}));
