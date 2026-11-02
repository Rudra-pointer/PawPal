import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { query, withTransaction } from '../db/pool.js';
import { requireRole } from './auth.js';
import { listKnownBreeds, suggestBreed } from '../domain/petKnowledge.js';
import { detectImageMime, safeUploadName } from '../uploads/validation.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { createPetSchema, petIdParamsSchema, petPhotoParamsSchema, photoOrderSchema, shelterPetListSchema, speciesQuerySchema, updatePetSchema, vaccinationSchema, vaccineParamsSchema } from '../schemas/shelterPets.js';

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = Router();
const shelterOnly = requireRole('shelter');
const photoRateLimit = rateLimit({ max: 30, keyPrefix: 'pet-photo-uploads', code: 'UPLOAD_RATE_LIMITED', message: 'Too many photo uploads. Please try again later.' });
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 6, fields: 4, parts: 12 } }).array('photos', 6);
const fields = ['name','species','breed','age_months','gender','size','weight_kg','coat','colors','description','temperament','energy_level','spayed_neutered','microchipped','house_trained','special_needs','special_needs_notes','health_notes','good_with_children','good_with_dogs','good_with_cats','bonded_pet_id'];

function fail(status, code, message) { return Object.assign(new Error(message), { status, errorCode: code }); }
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw Object.assign(new Error('Please check the highlighted pet fields.'), { status: 400, errorCode: 'VALIDATION_ERROR', details: result.error.issues });
  return result.data;
}
function mapPet(row) {
  return {
    id: row.id, shelterId: row.shelter_id, name: row.name, species: row.species, breed: row.breed,
    ageMonths: row.age_months, ageGroup: row.age_group, gender: row.gender, size: row.size, weightKg: row.weight_kg,
    coat: row.coat, colors: row.colors, description: row.description, temperament: row.temperament,
    energyLevel: row.energy_level, spayedNeutered: row.spayed_neutered, microchipped: row.microchipped,
    houseTrained: row.house_trained, specialNeeds: row.special_needs, specialNeedsNotes: row.special_needs_notes,
    healthNotes: row.health_notes, goodWithChildren: row.good_with_children, goodWithDogs: row.good_with_dogs,
    goodWithCats: row.good_with_cats, bondedPetId: row.bonded_pet_id, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at, removedAt: row.removed_at,
  };
}

async function getOwnerShelter(executor, ownerId, lock = false) {
  const sql = lock
    ? 'SELECT id,verification_status FROM shelters WHERE owner_user_id=$1 FOR UPDATE'
    : 'SELECT id,verification_status FROM shelters WHERE owner_user_id=$1';
  const result = await executor.query(sql, [ownerId]);
  if (!result.rows[0]) throw fail(404, 'SHELTER_NOT_FOUND', 'Register your shelter before managing pets.');
  return result.rows[0];
}

async function getOwnedPet(executor, shelterId, petId, lock = false) {
  const sql = lock
    ? 'SELECT * FROM pets WHERE id=$1 AND shelter_id=$2 FOR UPDATE'
    : 'SELECT * FROM pets WHERE id=$1 AND shelter_id=$2';
  const result = await executor.query(sql, [petId, shelterId]);
  if (!result.rows[0]) throw fail(404, 'NOT_FOUND', 'Pet not found in your shelter.');
  return result.rows[0];
}

function assertVerified(shelter) {
  if (shelter.verification_status !== 'verified') throw fail(409, 'SHELTER_NOT_VERIFIED', 'Your shelter must be verified before you can publish a pet.');
}

async function validateBond(client, shelterId, petId, species, partnerId) {
  if (!partnerId) return null;
  if (petId && partnerId === petId) throw fail(422, 'RULE_VIOLATION', 'A pet cannot be its own bonded partner.');
  const { rows } = await client.query('SELECT id,species,bonded_pet_id FROM pets WHERE id=$1 AND shelter_id=$2 FOR UPDATE', [partnerId, shelterId]);
  const partner = rows[0];
  if (!partner) throw fail(422, 'INVALID_BONDED_PARTNER', 'Choose a pet from your shelter as the bonded partner.');
  if (partner.species !== species) throw fail(422, 'INVALID_BONDED_PARTNER', 'Bonded pets must be the same species.');
  if (partner.bonded_pet_id && partner.bonded_pet_id !== petId) throw fail(409, 'PET_ALREADY_BONDED', 'That pet already has a bonded partner.');
  return partner;
}

const insertSql = `
  INSERT INTO pets (
    shelter_id,name,species,breed,age_months,gender,size,weight_kg,coat,colors,description,temperament,energy_level,
    spayed_neutered,microchipped,house_trained,special_needs,special_needs_notes,health_notes,
    good_with_children,good_with_dogs,good_with_cats,bonded_pet_id,status
  ) VALUES ($1,$2,$3,$4,$5,$6::gender_type,$7::size_type,$8,$9,$10,$11,$12,$13::energy_type,
    $14,$15,$16,$17,$18,$19,$20::tri_state,$21::tri_state,$22::tri_state,$23,'available') RETURNING *
`;
function petValues(shelterId, pet, bondedPetId) {
  return [shelterId,pet.name,pet.species,pet.breed,pet.ageMonths,pet.gender,pet.size,pet.weightKg ?? null,pet.coat ?? null,
    pet.colors,pet.description,pet.temperament,pet.energyLevel,pet.spayedNeutered,pet.microchipped,pet.houseTrained,
    pet.specialNeeds,pet.specialNeedsNotes ?? null,pet.healthNotes ?? null,pet.goodWithChildren,pet.goodWithDogs,
    pet.goodWithCats,bondedPetId ?? null];
}

router.get('/pet-knowledge', ...shelterOnly, asyncHandler(async (req, res) => {
  const { species } = parse(speciesQuerySchema, req.query);
  res.json({ breeds: listKnownBreeds(species) });
}));

router.get('/dashboard', ...shelterOnly, asyncHandler(async (req, res) => {
  const shelter = await getOwnerShelter({ query }, req.user.id);
  const [stats, applications] = await Promise.all([
    query('SELECT shelter_id,total_pets,available_pets,open_applications,completed_this_year FROM v_shelter_stats WHERE shelter_id=$1', [shelter.id]),
    query(`SELECT a.id,a.status,a.submitted_at,a.applicant_name,p.id AS pet_id,p.name AS pet_name
      FROM applications a JOIN pets p ON p.id=a.pet_id
      WHERE a.shelter_id=$1 ORDER BY a.submitted_at DESC,a.id LIMIT 8`, [shelter.id]),
  ]);
  res.json({ verificationStatus:shelter.verification_status,stats:stats.rows[0] ?? {total_pets:0,available_pets:0,open_applications:0,completed_this_year:0},latestApplications:applications.rows });
}));

router.get('/pets', ...shelterOnly, asyncHandler(async (req, res) => {
  const filters = parse(shelterPetListSchema, req.query);
  const shelter = await getOwnerShelter({ query }, req.user.id);
  const { rows } = await query(`
    WITH filtered AS (
      SELECT p.* FROM pets p WHERE p.shelter_id=$1
        AND ($2::text IS NULL OR p.status::text=$2)
        AND ($3::text IS NULL OR p.species::text=$3)
        AND ($4='' OR p.name ILIKE '%'||$4||'%' OR p.breed ILIKE '%'||$4||'%')
    ), counted AS (SELECT count(*)::int AS total FROM filtered)
    SELECT counted.total, page.*,
      photo.url AS photo_url, photo.id AS photo_id
    FROM counted LEFT JOIN LATERAL (
      SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT $5 OFFSET $6
    ) page ON TRUE
    LEFT JOIN LATERAL (SELECT id,url FROM pet_photos WHERE pet_id=page.id ORDER BY is_primary DESC,position,id LIMIT 1) photo ON TRUE
    ORDER BY page.created_at DESC,page.id
  `, [shelter.id, filters.status ?? null, filters.species ?? null, filters.q, filters.pageSize, (filters.page - 1) * filters.pageSize]);
  const total = rows[0]?.total ?? 0;
  const items = rows.filter(row => row.id).map(row => ({ ...mapPet(row), primaryPhoto: row.photo_url ?? (row.photo_id ? `/api/photos/${row.photo_id}` : null) }));
  const species = await query(`SELECT species,count(*)::int AS count FROM pets
    WHERE shelter_id=$1 AND status<>'removed' GROUP BY species ORDER BY species`, [shelter.id]);
  res.json({ items, total, page: filters.page, pageSize: filters.pageSize, totalPages: Math.ceil(total / filters.pageSize), verificationStatus: shelter.verification_status, species: species.rows });
}));

function csvCell(value) {
  let cell = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"','""')}"`;
}

router.get('/pets/export.csv', ...shelterOnly, asyncHandler(async (req, res) => {
  const filters = parse(shelterPetListSchema, req.query);
  const shelter = await getOwnerShelter({ query }, req.user.id);
  const { rows } = await query(`
    SELECT p.name,p.species,p.breed,p.age_months,p.size,p.energy_level,p.status,p.created_at
      FROM pets p WHERE p.shelter_id=$1 AND ($2::text IS NULL OR p.status::text=$2)
        AND ($3::text IS NULL OR p.species::text=$3)
        AND ($4='' OR p.name ILIKE '%'||$4||'%' OR p.breed ILIKE '%'||$4||'%')
     ORDER BY p.created_at DESC,p.id
  `, [shelter.id, filters.status ?? null, filters.species ?? null, filters.q]);
  const csv = [['Name','Species','Breed','Age months','Size','Energy','Status','Created'], ...rows.map(row => [row.name,row.species,row.breed,row.age_months,row.size,row.energy_level,row.status,row.created_at?.toISOString()])]
    .map(row => row.map(csvCell).join(',')).join('\r\n');
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="pawpal-pets.csv"').send(csv);
}));

router.post('/pets', ...shelterOnly, asyncHandler(async (req, res) => {
  const pet = parse(createPetSchema, req.body);
  const created = await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    assertVerified(shelter);
    const partner = await validateBond(client, shelter.id, null, pet.species, pet.bondedPetId);
    const result = await client.query(insertSql, petValues(shelter.id, pet, partner?.id));
    if (partner) await client.query('UPDATE pets SET bonded_pet_id=$1 WHERE id=$2', [result.rows[0].id, partner.id]);
    return result.rows[0];
  });
  res.status(201).json({ pet: mapPet(created) });
}));

router.get('/pets/:petId', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId } = parse(petIdParamsSchema, req.params);
  const shelter = await getOwnerShelter({ query }, req.user.id);
  const pet = await getOwnedPet({ query }, shelter.id, petId);
  const [photos, vaccines, partners] = await Promise.all([
    query('SELECT id,position,is_primary,url,mime_type,byte_size FROM pet_photos WHERE pet_id=$1 ORDER BY position,id', [petId]),
    query(`SELECT pv.*,vt.code,vt.name,vt.species,vt.is_core FROM pet_vaccinations pv JOIN vaccine_types vt ON vt.id=pv.vaccine_type_id WHERE pv.pet_id=$1 ORDER BY pv.given_on DESC,pv.id`, [petId]),
    query('SELECT id,name FROM pets WHERE shelter_id=$1 AND id<>$2 AND species=$3 AND status<>\'removed\' ORDER BY name,id', [shelter.id, petId, pet.species]),
  ]);
  res.json({ pet: mapPet(pet), photos: photos.rows.map(row => ({ ...row, url: row.url ?? `/api/photos/${row.id}` })), vaccinations: vaccines.rows, bondedCandidates: partners.rows });
}));

router.put('/pets/:petId', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId } = parse(petIdParamsSchema, req.params);
  const changes = parse(updatePetSchema, req.body);
  const updated = await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    const current = await getOwnedPet(client, shelter.id, petId, true);
    const next = {
      name: changes.name ?? current.name, species: changes.species ?? current.species, breed: changes.breed ?? current.breed,
      ageMonths: changes.ageMonths ?? current.age_months, gender: changes.gender ?? current.gender, size: changes.size ?? current.size,
      weightKg: Object.hasOwn(changes,'weightKg') ? changes.weightKg : current.weight_kg, coat: Object.hasOwn(changes,'coat') ? changes.coat : current.coat,
      colors: changes.colors ?? current.colors, description: changes.description ?? current.description, temperament: changes.temperament ?? current.temperament,
      energyLevel: changes.energyLevel ?? current.energy_level, spayedNeutered: changes.spayedNeutered ?? current.spayed_neutered,
      microchipped: changes.microchipped ?? current.microchipped, houseTrained: changes.houseTrained ?? current.house_trained,
      specialNeeds: changes.specialNeeds ?? current.special_needs,
      specialNeedsNotes: Object.hasOwn(changes,'specialNeedsNotes') ? changes.specialNeedsNotes : current.special_needs_notes,
      healthNotes: Object.hasOwn(changes,'healthNotes') ? changes.healthNotes : current.health_notes,
      goodWithChildren: changes.goodWithChildren ?? current.good_with_children, goodWithDogs: changes.goodWithDogs ?? current.good_with_dogs,
      goodWithCats: changes.goodWithCats ?? current.good_with_cats,
    };
    const bondedId = Object.hasOwn(changes,'bondedPetId') ? changes.bondedPetId : current.bonded_pet_id;
    const partner = await validateBond(client, shelter.id, petId, next.species, bondedId);
    if (current.bonded_pet_id && current.bonded_pet_id !== bondedId) {
      await client.query('UPDATE pets SET bonded_pet_id=NULL WHERE id=$1 AND bonded_pet_id=$2', [current.bonded_pet_id, petId]);
    }
    const result = await client.query(`
      UPDATE pets SET name=$2,species=$3,breed=$4,age_months=$5,gender=$6::gender_type,size=$7::size_type,
        weight_kg=$8,coat=$9,colors=$10,description=$11,temperament=$12,energy_level=$13::energy_type,
        spayed_neutered=$14,microchipped=$15,house_trained=$16,special_needs=$17,special_needs_notes=$18,health_notes=$19,
        good_with_children=$20::tri_state,good_with_dogs=$21::tri_state,good_with_cats=$22::tri_state,bonded_pet_id=$23
      WHERE id=$1 AND shelter_id=$24 RETURNING *
    `, [petId,next.name,next.species,next.breed,next.ageMonths,next.gender,next.size,next.weightKg,next.coat,next.colors,next.description,next.temperament,
      next.energyLevel,next.spayedNeutered,next.microchipped,next.houseTrained,next.specialNeeds,next.specialNeedsNotes,next.healthNotes,
      next.goodWithChildren,next.goodWithDogs,next.goodWithCats,bondedId,shelter.id]);
    if (partner) await client.query('UPDATE pets SET bonded_pet_id=$1 WHERE id=$2', [petId, partner.id]);
    return result.rows[0];
  });
  res.json({ pet: mapPet(updated) });
}));

router.delete('/pets/:petId', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId } = parse(petIdParamsSchema, req.params);
  const pet = await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    const current = await getOwnedPet(client, shelter.id, petId, true);
    const approved = await client.query("SELECT 1 FROM applications WHERE pet_id=$1 AND status='approved' LIMIT 1", [petId]);
    if (approved.rowCount) throw fail(409, 'PET_HAS_APPROVED_APPLICATION', 'This pet cannot be removed while an application is approved.');
    if (current.bonded_pet_id) await client.query('UPDATE pets SET bonded_pet_id=NULL WHERE id=$1 AND bonded_pet_id=$2', [current.bonded_pet_id, petId]);
    const result = await client.query("UPDATE pets SET status='removed',removed_at=COALESCE(removed_at,now()) WHERE id=$1 AND shelter_id=$2 RETURNING *", [petId, shelter.id]);
    return result.rows[0];
  });
  res.json({ pet: mapPet(pet) });
}));

function receivePhotos(req, res, next) {
  photoUpload(req, res, error => {
    if (error) return next(error);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose at least one JPG or PNG photo.', details: [] } });
    if (files.some(file => !detectImageMime(file))) return res.status(400).json({ error: { code: 'INVALID_IMAGE', message: 'Each photo must have matching JPG or PNG content, file extension and content type.', details: [] } });
    next();
  });
}

async function processPhoto(file) {
  const image = sharp(file.buffer, { limitInputPixels: 40_000_000, failOn: 'error' });
  const metadata = await image.metadata();
  const expected = file.mimetype === 'image/png' ? 'png' : 'jpeg';
  if (metadata.format !== expected || !metadata.width || !metadata.height) throw fail(400, 'INVALID_IMAGE', 'The uploaded photo is malformed or unsupported.');
  const data = await image.rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { data, fileName: safeUploadName(file.originalname), byteSize: data.length };
}

router.post('/pets/:petId/photos', ...shelterOnly, photoRateLimit, receivePhotos, asyncHandler(async (req, res) => {
  const { petId } = parse(petIdParamsSchema, req.params);
  let processed;
  try { processed = await Promise.all(req.files.map(processPhoto)); }
  catch (error) { if (error.status) throw error; throw fail(400, 'INVALID_IMAGE', 'The uploaded photo is malformed or unsupported.'); }
  const photos = await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    assertVerified(shelter);
    await getOwnedPet(client, shelter.id, petId, true);
    const existing = await client.query('SELECT count(*)::int AS total FROM pet_photos WHERE pet_id=$1', [petId]);
    const total = existing.rows[0].total;
    if (total + processed.length > 6) throw fail(413, 'PHOTO_LIMIT_EXCEEDED', 'A pet can have no more than six photos.');
    const created = [];
    for (let index=0; index<processed.length; index++) {
      const photo = processed[index];
      const inserted = await client.query(`
        INSERT INTO pet_photos (pet_id,position,is_primary,url,data,mime_type,byte_size)
        VALUES ($1,$2,$3,NULL,$4,'image/jpeg',$5) RETURNING id,position,is_primary,mime_type,byte_size
      `, [petId,total+index,total===0 && index===0,photo.data,photo.byteSize]);
      created.push({ ...inserted.rows[0], fileName: photo.fileName, url: `/api/photos/${inserted.rows[0].id}` });
    }
    return created;
  });
  res.status(201).json({ photos });
}));

router.patch('/pets/:petId/photos/:photoId/primary', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId, photoId } = parse(petPhotoParamsSchema, req.params);
  const photo = await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    await getOwnedPet(client, shelter.id, petId, true);
    const found = await client.query('SELECT id FROM pet_photos WHERE id=$1 AND pet_id=$2 FOR UPDATE', [photoId, petId]);
    if (!found.rows[0]) throw fail(404, 'NOT_FOUND', 'Photo not found for this pet.');
    await client.query('UPDATE pet_photos SET is_primary=false WHERE pet_id=$1 AND is_primary=true', [petId]);
    const result = await client.query('UPDATE pet_photos SET is_primary=true WHERE id=$1 RETURNING id,position,is_primary,mime_type,byte_size', [photoId]);
    return result.rows[0];
  });
  res.json({ photo: { ...photo, url: `/api/photos/${photo.id}` } });
}));

router.put('/pets/:petId/photos/order', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId } = parse(petIdParamsSchema, req.params);
  const { photoIds } = parse(photoOrderSchema, req.body);
  const photos = await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    await getOwnedPet(client, shelter.id, petId, true);
    const current = await client.query('SELECT id FROM pet_photos WHERE pet_id=$1 ORDER BY position,id FOR UPDATE', [petId]);
    const currentIds = current.rows.map(row => row.id);
    if (photoIds.length !== currentIds.length || photoIds.some(id => !currentIds.includes(id)) || new Set(photoIds).size !== photoIds.length) {
      throw fail(422, 'INVALID_PHOTO_ORDER', 'Include every photo for this pet exactly once.');
    }
    for (const [position,id] of photoIds.entries()) await client.query('UPDATE pet_photos SET position=$1 WHERE id=$2 AND pet_id=$3', [position,id,petId]);
    const result = await client.query('SELECT id,position,is_primary,mime_type,byte_size FROM pet_photos WHERE pet_id=$1 ORDER BY position,id', [petId]);
    return result.rows.map(photo => ({ ...photo,url: `/api/photos/${photo.id}` }));
  });
  res.json({ photos });
}));

router.delete('/pets/:petId/photos/:photoId', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId, photoId } = parse(petPhotoParamsSchema, req.params);
  await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    await getOwnedPet(client, shelter.id, petId, true);
    const found = await client.query('SELECT is_primary FROM pet_photos WHERE id=$1 AND pet_id=$2 FOR UPDATE', [photoId,petId]);
    if (!found.rows[0]) throw fail(404, 'NOT_FOUND', 'Photo not found for this pet.');
    await client.query('DELETE FROM pet_photos WHERE id=$1 AND pet_id=$2', [photoId,petId]);
    if (found.rows[0].is_primary) {
      const next = await client.query('SELECT id FROM pet_photos WHERE pet_id=$1 ORDER BY position,id LIMIT 1', [petId]);
      if (next.rows[0]) await client.query('UPDATE pet_photos SET is_primary=true WHERE id=$1', [next.rows[0].id]);
    }
  });
  res.json({ deleted: true, photoId });
}));

router.get('/pets/:petId/vaccinations', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId } = parse(petIdParamsSchema, req.params);
  const shelter = await getOwnerShelter({ query }, req.user.id);
  const pet = await getOwnedPet({ query }, shelter.id, petId);
  const [types, records] = await Promise.all([
    query(`SELECT id,species,code,name,description,is_core,first_dose_weeks,is_generic FROM vaccine_types
      WHERE species=$1 OR (is_generic AND NOT EXISTS (SELECT 1 FROM vaccine_types mapped WHERE mapped.species=$1))
      ORDER BY is_core DESC,is_generic,name`, [pet.species]),
    query(`SELECT pv.id,pv.vaccine_type_id,pv.given_on,pv.next_due_on,pv.clinic,pv.notes,vt.code,vt.name,vt.is_core
             FROM pet_vaccinations pv JOIN vaccine_types vt ON vt.id=pv.vaccine_type_id
            WHERE pv.pet_id=$1 ORDER BY pv.given_on DESC,pv.id`, [petId]),
  ]);
  res.json({ species: pet.species, vaccineTypes: types.rows, vaccinations: records.rows });
}));

router.post('/pets/:petId/vaccinations', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId } = parse(petIdParamsSchema, req.params);
  const vaccination = parse(vaccinationSchema, req.body);
  const result = await withTransaction(async client => {
    const shelter = await getOwnerShelter(client, req.user.id, true);
    const pet = await getOwnedPet(client, shelter.id, petId, true);
    const vaccine = await client.query(`SELECT id FROM vaccine_types WHERE id=$1 AND (
      species=$2 OR (is_generic AND NOT EXISTS (SELECT 1 FROM vaccine_types mapped WHERE mapped.species=$2))
    )`, [vaccination.vaccineTypeId,pet.species]);
    if (!vaccine.rows[0]) throw fail(422, 'VACCINE_SPECIES_MISMATCH', 'Choose a vaccine type that applies to this pet species.');
    const today = await client.query('SELECT CURRENT_DATE::text AS today');
    if (vaccination.givenOn > today.rows[0].today) throw fail(422, 'FUTURE_VACCINATION_DATE', 'A vaccination date cannot be in the future.');
    const inserted = await client.query(`
      INSERT INTO pet_vaccinations (pet_id,vaccine_type_id,given_on,next_due_on,clinic,notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [petId,vaccination.vaccineTypeId,vaccination.givenOn,vaccination.nextDueOn ?? null,vaccination.clinic ?? null,vaccination.notes ?? null]);
    return inserted.rows[0];
  });
  res.status(201).json({ vaccination: result });
}));

router.delete('/pets/:petId/vaccinations/:vaccinationId', ...shelterOnly, asyncHandler(async (req, res) => {
  const { petId, vaccinationId } = parse(vaccineParamsSchema, req.params);
  const shelter = await getOwnerShelter({ query }, req.user.id);
  await getOwnedPet({ query }, shelter.id, petId);
  const result = await query('DELETE FROM pet_vaccinations WHERE id=$1 AND pet_id=$2 RETURNING id', [vaccinationId,petId]);
  if (!result.rowCount) throw fail(404, 'NOT_FOUND', 'Vaccination record not found for this pet.');
  res.json({ deleted: true, vaccinationId });
}));

export const shelterPetsRouter = router;
