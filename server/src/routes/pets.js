import { Router } from 'express';
import { query } from '../db/pool.js';
import { browsePetsQuerySchema, uuidParamSchema, validationError } from '../schemas/petDiscovery.js';
import { browsePetsSql, buildReadiness, computeVaccinationStatus, mapBrowseRow, toAgeLabel } from '../services/petDiscovery.js';

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
export const petsRouter = Router();

petsRouter.get('/', asyncRoute(async (req, res) => {
  const parsed = browsePetsQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, 'Check the pet search filters.', parsed.error.issues);
  const filters = parsed.data;
  const values = [
    filters.species ?? null,
    filters.breed ?? null,
    filters.ageGroup ?? null,
    filters.gender ?? null,
    filters.size ?? null,
    filters.city ?? null,
    filters.status,
    filters.energy ?? null,
    filters.q ?? null,
    filters.sort,
    filters.pageSize,
    (filters.page - 1) * filters.pageSize,
  ];
  const { rows } = await query(browsePetsSql, values);
  const total = rows[0]?.result_total ?? 0;
  const items = rows.filter(row => row.id).map(mapBrowseRow);
  res.json({ items, total, page: filters.page, pageSize: filters.pageSize, totalPages: Math.ceil(total / filters.pageSize) });
}));

petsRouter.get('/:id', asyncRoute(async (req, res) => {
  const parsedId = uuidParamSchema.safeParse(req.params.id);
  if (!parsedId.success) return validationError(res, 'Enter a valid pet ID.');
  const { rows } = await query(`
    SELECT p.*, s.id AS shelter_id, s.name AS shelter_name, s.city AS shelter_city,
           s.state AS shelter_state, s.verification_status,
           partner.id AS partner_id, partner.name AS partner_name
    FROM pets p
    JOIN shelters s ON s.id = p.shelter_id AND s.verification_status = 'verified'
    JOIN users u ON u.id = s.owner_user_id AND u.status = 'active'
    LEFT JOIN pets partner ON partner.id = p.bonded_pet_id AND partner.status <> 'removed'
    WHERE p.id = $1 AND p.status <> 'removed'
  `, [parsedId.data]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This pet profile is no longer available.', details: [] } });

  const [photoResult, vaccineResult, similarResult] = await Promise.all([
    query(`SELECT id, position, is_primary, url, mime_type, byte_size
           FROM pet_photos WHERE pet_id = $1
           ORDER BY is_primary DESC, position ASC, id ASC`, [row.id]),
    query(`SELECT vt.id, vt.code, vt.name, vt.description, vt.is_core, vt.is_generic,
                  pv.id AS record_id, pv.given_on, pv.next_due_on, pv.clinic, pv.notes
           FROM vaccine_types vt
           LEFT JOIN pet_vaccinations pv ON pv.vaccine_type_id = vt.id AND pv.pet_id = $1
           WHERE vt.species = $2 OR (vt.is_generic AND NOT EXISTS (
             SELECT 1 FROM vaccine_types mapped WHERE mapped.species = $2
           ))
           ORDER BY vt.is_core DESC, vt.is_generic, vt.name, pv.given_on DESC`, [row.id, row.species]),
    query(`SELECT p.id, p.name, p.species::text AS species, p.breed, p.age_months,
                  p.age_group::text AS age_group, p.gender::text AS gender,
                  p.size::text AS size, p.energy_level::text AS energy,
                  p.status::text AS status, s.city, s.state,
                  CASE WHEN photo.url IS NOT NULL THEN photo.url
                       WHEN photo.id IS NOT NULL THEN '/api/photos/' || photo.id::text
                       ELSE NULL END AS primary_photo,
                  (CASE WHEN p.size = base.size THEN 3 ELSE 0 END
                   + CASE WHEN p.energy_level = base.energy_level THEN 2 ELSE 0 END
                   + (SELECT count(*)::int FROM unnest(p.temperament) t WHERE t = ANY(base.temperament))) AS score
           FROM pets base
           JOIN pets p ON p.species = base.species AND p.id <> base.id AND p.status = 'available'
           JOIN shelters s ON s.id = p.shelter_id AND s.verification_status = 'verified'
           JOIN users u ON u.id = s.owner_user_id AND u.status = 'active'
           LEFT JOIN LATERAL (SELECT id, url FROM pet_photos WHERE pet_id = p.id
                              ORDER BY is_primary DESC, position ASC, id ASC LIMIT 1) photo ON TRUE
           WHERE base.id = $1
           ORDER BY score DESC, p.created_at DESC, p.id
           LIMIT 4`, [row.id]),
  ]);

  const vaccineMap = new Map();
  for (const vaccine of vaccineResult.rows) {
    if (!vaccineMap.has(vaccine.id)) vaccineMap.set(vaccine.id, {
      id: vaccine.id, code: vaccine.code, name: vaccine.name,
      description: vaccine.description, isCore: vaccine.is_core, isGeneric: vaccine.is_generic, records: [],
    });
    if (vaccine.record_id) vaccineMap.get(vaccine.id).records.push({
      id: vaccine.record_id,
      givenOn: vaccine.given_on,
      nextDueOn: vaccine.next_due_on,
      clinic: vaccine.clinic,
      notes: vaccine.notes,
    });
  }
  const vaccinations = [...vaccineMap.values()].map(vaccine => ({
    ...vaccine,
    status: computeVaccinationStatus(vaccine.records[0]),
  }));
  const primaryPhoto = photoResult.rows.find(photo => photo.is_primary) ?? photoResult.rows[0] ?? null;
  const photos = photoResult.rows.map(photo => ({
    id: photo.id,
    position: photo.position,
    isPrimary: photo.is_primary,
    url: photo.url ?? `/api/photos/${photo.id}`,
    mimeType: photo.mime_type,
    byteSize: photo.byte_size,
  }));
  const pet = {
    id: row.id,
    shelterId: row.shelter_id,
    bondedPetId: row.bonded_pet_id,
    name: row.name,
    species: row.species,
    breed: row.breed,
    ageMonths: row.age_months,
    ageLabel: toAgeLabel(row.age_months),
    ageGroup: row.age_group,
    gender: row.gender,
    size: row.size,
    weightKg: row.weight_kg,
    coat: row.coat,
    colors: row.colors,
    description: row.description,
    temperament: row.temperament,
    energyLevel: row.energy_level,
    spayedNeutered: row.spayed_neutered,
    microchipped: row.microchipped,
    houseTrained: row.house_trained,
    specialNeeds: row.special_needs,
    specialNeedsNotes: row.special_needs_notes,
    healthNotes: row.health_notes,
    status: row.status,
    source: row.source,
    externalId: row.external_id,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
  const goodWith = {
    children: row.good_with_children,
    dogs: row.good_with_dogs,
    cats: row.good_with_cats,
  };
  const readiness = buildReadiness(pet, vaccinations);
  const similarPets = similarResult.rows.map(similar => ({
    ...mapBrowseRow({ ...similar, badges: [], total: 0 }),
    score: similar.score,
  }));
  res.json({
    ...pet,
    primaryPhoto: primaryPhoto ? (primaryPhoto.url ?? `/api/photos/${primaryPhoto.id}`) : null,
    photos,
    shelter: {
      id: row.shelter_id,
      name: row.shelter_name,
      city: row.shelter_city,
      state: row.shelter_state,
      verified: row.verification_status === 'verified',
    },
    health: {
      specialNeeds: row.special_needs,
      specialNeedsNotes: row.special_needs_notes,
      notes: row.health_notes,
      spayedNeutered: row.spayed_neutered,
      microchipped: row.microchipped,
    },
    goodWith,
    bondedPartner: row.partner_id ? { id: row.partner_id, name: row.partner_name } : null,
    vaccinations,
    readiness,
    similarPets,
  });
}));
