export const browsePetsSql = `
  WITH filtered AS MATERIALIZED (
    SELECT p.id, p.name, p.species::text AS species, p.breed,
           p.age_months, p.age_group::text AS age_group,
           p.gender::text AS gender, p.size::text AS size,
           p.energy_level::text AS energy, p.status::text AS status,
           p.created_at, s.city, s.state,
           ARRAY_REMOVE(ARRAY[
             CASE WHEN p.spayed_neutered THEN 'Spayed/neutered' END,
             CASE WHEN p.microchipped THEN 'Microchipped' END,
             CASE WHEN p.house_trained THEN
               CASE WHEN p.species = 'dog' THEN 'House-trained'
                    WHEN p.species IN ('cat', 'rabbit') THEN 'Litter-trained'
                    ELSE 'Trained' END
             END
           ], NULL) AS badges,
           count(*) OVER()::int AS total
    FROM pets p
    JOIN shelters s ON s.id = p.shelter_id AND s.verification_status = 'verified'
    JOIN users u ON u.id = s.owner_user_id AND u.status = 'active'
    WHERE p.status = $7::pet_status
      AND p.status <> 'removed'
      AND ($1::text[] IS NULL OR p.species = ANY($1::text[]))
      AND ($2::text IS NULL OR p.breed ILIKE '%' || $2 || '%')
      AND ($3::age_group_type[] IS NULL OR p.age_group = ANY($3::age_group_type[]))
      AND ($4::gender_type IS NULL OR p.gender = $4::gender_type)
      AND ($5::size_type[] IS NULL OR p.size = ANY($5::size_type[]))
      AND ($6::text IS NULL OR lower(s.city) = lower($6))
      AND ($8::energy_type IS NULL OR p.energy_level = $8::energy_type)
      AND ($9::text IS NULL OR CASE
        WHEN length($9) <= 3 THEN
          p.name ILIKE '%' || $9 || '%' OR p.breed ILIKE '%' || $9 || '%'
          OR p.description ILIKE '%' || $9 || '%'
        ELSE to_tsvector('simple', p.name || ' ' || p.breed || ' ' || p.description)
          @@ plainto_tsquery('simple', $9)
      END)
  ),
  page_rows AS (
    SELECT * FROM filtered
    ORDER BY
      CASE WHEN $10 = 'newest' THEN created_at END DESC NULLS LAST,
      CASE WHEN $10 = 'name' THEN lower(name) END ASC NULLS LAST,
      CASE WHEN $10 = 'age_asc' THEN age_months END ASC NULLS LAST,
      CASE WHEN $10 = 'age_desc' THEN age_months END DESC NULLS LAST,
      id ASC
    LIMIT $11 OFFSET $12
  ),
  total_rows AS (SELECT count(*)::int AS total FROM filtered)
  SELECT page_rows.*, coalesce(page_rows.total, total_rows.total) AS result_total,
         photo.id AS photo_id,
         CASE WHEN photo.url IS NOT NULL THEN photo.url
              WHEN photo.id IS NOT NULL THEN '/api/photos/' || photo.id::text
              ELSE NULL END AS primary_photo
  FROM total_rows
  LEFT JOIN page_rows ON TRUE
  LEFT JOIN LATERAL (
    SELECT id, url FROM pet_photos
    WHERE pet_id = page_rows.id
    ORDER BY is_primary DESC, position ASC, id ASC
    LIMIT 1
  ) photo ON TRUE
  ORDER BY
    CASE WHEN $10 = 'newest' THEN page_rows.created_at END DESC NULLS LAST,
    CASE WHEN $10 = 'name' THEN lower(page_rows.name) END ASC NULLS LAST,
    CASE WHEN $10 = 'age_asc' THEN page_rows.age_months END ASC NULLS LAST,
    CASE WHEN $10 = 'age_desc' THEN page_rows.age_months END DESC NULLS LAST,
    page_rows.id ASC
`;

export function toAgeLabel(months) {
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return remainder === 0 ? `${years} yr${years === 1 ? '' : 's'}` : `${years} yr${years === 1 ? '' : 's'} ${remainder} mo`;
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function computeVaccinationStatus(record, today = new Date()) {
  if (!record) return 'not_recorded';
  const due = dateOnly(record.next_due_on ?? record.nextDueOn);
  if (!due) return 'up_to_date';
  const current = dateOnly(today);
  const days = Math.floor((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${current}T00:00:00Z`)) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 30) return 'due_soon';
  return 'up_to_date';
}

export function buildReadiness(pet, vaccineStatuses) {
  const core = vaccineStatuses.filter(vaccine => vaccine.isCore);
  const vaccineReady = core.length > 0
    ? core.every(vaccine => ['up_to_date', 'due_soon'].includes(vaccine.status))
    : vaccineStatuses.some(vaccine => vaccine.records?.length > 0);
  return [
    { label: 'Vaccinated', ready: vaccineReady },
    { label: 'Spayed/Neutered', ready: pet.spayed_neutered ?? pet.spayedNeutered },
    { label: 'Microchipped', ready: pet.microchipped },
    { label: pet.species === 'dog' ? 'House-trained' : ['cat', 'rabbit'].includes(pet.species) ? 'Litter-trained' : 'Trained', ready: pet.house_trained ?? pet.houseTrained },
  ];
}

export function mapBrowseRow(row) {
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    breed: row.breed,
    ageLabel: toAgeLabel(row.age_months),
    ageGroup: row.age_group,
    gender: row.gender,
    size: row.size,
    city: row.city,
    state: row.state,
    status: row.status,
    primaryPhoto: row.primary_photo,
    badges: row.badges ?? [],
  };
}
