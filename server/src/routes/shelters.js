import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db/pool.js';
import { requireRole } from './auth.js';
import { shelterProfileSchema, shelterUpdateSchema } from '../schemas/shelters.js';
import { detectDocumentMime, safeUploadName } from '../uploads/validation.js';
import { rateLimit } from '../middleware/rateLimit.js';

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const sheltersRouter = Router();
const shelterOnly = requireRole('shelter');
const documentRateLimit = rateLimit({ max: 12, keyPrefix: 'shelter-documents', code: 'UPLOAD_RATE_LIMITED', message: 'Too many document uploads. Please try again later.' });
const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 3, fields: 12, parts: 16 } }).array('documents', 3);

function parsed(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(new Error('Please check the highlighted shelter fields.'), { status: 400, errorCode: 'VALIDATION_ERROR', details: result.error.issues });
  return result.data;
}

function receiveDocuments(req, res, next) {
  documentUpload(req, res, error => {
    if (error) return next(error);
    const files = req.files || [];
    if (files.length < 1 || files.length > 3) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Upload one to three verification documents.', details: [] } });
    const invalid = files.find(file => !detectDocumentMime(file));
    if (invalid) return res.status(400).json({ error: { code: 'INVALID_DOCUMENT', message: 'Each document must be a valid PDF, JPG or PNG with a matching file name and content type.', details: [] } });
    next();
  });
}

async function getShelterForOwner(ownerId, client = null, lock = false) {
  const executor = client || { query };
  const result = await executor.query(`SELECT * FROM shelters WHERE owner_user_id=$1${lock ? ' FOR UPDATE' : ''}`, [ownerId]);
  return result.rows[0] || null;
}

sheltersRouter.post('/', ...shelterOnly, documentRateLimit, receiveDocuments, asyncHandler(async (req, res) => {
  const profile = parsed(shelterProfileSchema, req.body);
  const created = await withTransaction(async client => {
    const owner = await client.query("SELECT id,status,role FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
    if (!owner.rows[0] || owner.rows[0].status !== 'active' || owner.rows[0].role !== 'shelter') {
      const error = new Error('An active shelter account is required.'); error.status = 403; error.errorCode = 'FORBIDDEN'; throw error;
    }
    const existing = await getShelterForOwner(req.user.id, client);
    if (existing) { const error = new Error('A shelter profile already exists for this account.'); error.status = 409; error.errorCode = 'SHELTER_EXISTS'; throw error; }
    const result = await client.query(`
      INSERT INTO shelters (owner_user_id,name,description,address_line,city,state,postcode,country,contact_email,contact_phone,website,verification_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') RETURNING *
    `, [req.user.id, profile.name, profile.description, profile.addressLine, profile.city, profile.state,
      profile.postcode ?? null, profile.country, profile.contactEmail, profile.contactPhone ?? null, profile.website || null]);
    const shelter = result.rows[0];
    for (const file of req.files) {
      const mime = detectDocumentMime(file);
      await client.query(`
        INSERT INTO shelter_documents (shelter_id,file_name,mime_type,byte_size,data)
        VALUES ($1,$2,$3,$4,$5)
      `, [shelter.id, safeUploadName(file.originalname), mime, file.size, file.buffer]);
    }
    return shelter;
  });
  res.status(201).json({ shelter: created, documentCount: req.files.length });
}));

sheltersRouter.get('/mine', ...shelterOnly, asyncHandler(async (req, res) => {
  const shelter = await getShelterForOwner(req.user.id);
  if (!shelter) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Your shelter profile has not been registered.', details: [] } });
  const documents = await query('SELECT id,file_name,mime_type,byte_size,uploaded_at FROM shelter_documents WHERE shelter_id=$1 ORDER BY uploaded_at,id', [shelter.id]);
  res.json({ shelter, documents: documents.rows });
}));

sheltersRouter.put('/mine', ...shelterOnly, asyncHandler(async (req, res) => {
  const update = parsed(shelterUpdateSchema, req.body);
  const current = await getShelterForOwner(req.user.id);
  if (!current) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Your shelter profile has not been registered.', details: [] } });
  const value = key => Object.hasOwn(update, key) ? update[key] : null;
  const { rows } = await query(`
    UPDATE shelters SET
      name=CASE WHEN $2 THEN $3 ELSE name END,
      description=CASE WHEN $4 THEN $5 ELSE description END,
      address_line=CASE WHEN $6 THEN $7 ELSE address_line END,
      city=CASE WHEN $8 THEN $9 ELSE city END,
      state=CASE WHEN $10 THEN $11 ELSE state END,
      postcode=CASE WHEN $12 THEN $13 ELSE postcode END,
      country=CASE WHEN $14 THEN $15 ELSE country END,
      contact_email=CASE WHEN $16 THEN $17 ELSE contact_email END,
      contact_phone=CASE WHEN $18 THEN $19 ELSE contact_phone END,
      website=CASE WHEN $20 THEN $21 ELSE website END
    WHERE id=$1 RETURNING *
  `, [current.id,
    Object.hasOwn(update, 'name'), value('name'), Object.hasOwn(update, 'description'), value('description'),
    Object.hasOwn(update, 'addressLine'), value('addressLine'), Object.hasOwn(update, 'city'), value('city'),
    Object.hasOwn(update, 'state'), value('state'), Object.hasOwn(update, 'postcode'), value('postcode'),
    Object.hasOwn(update, 'country'), value('country'), Object.hasOwn(update, 'contactEmail'), value('contactEmail'),
    Object.hasOwn(update, 'contactPhone'), value('contactPhone'), Object.hasOwn(update, 'website'), value('website')]);
  res.json({ shelter: rows[0] });
}));
