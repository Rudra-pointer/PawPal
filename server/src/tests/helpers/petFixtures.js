import { randomUUID } from 'node:crypto';

export async function createPetWorld(pool, { city = 'Portland', state = 'OR', userStatus = 'active', verified = 'verified', ownerUserId = null } = {}) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const users = ownerUserId ? { rows: [{ id: ownerUserId }] } : await pool.query(`
    INSERT INTO users (user_code,name,email,password_hash,role,status,city,state)
    VALUES ($1,$2,$3,$4,'shelter',$5,$6,$7) RETURNING id
  `, [`fixture_${suffix}`, `Fixture Owner ${suffix}`, `fixture_${suffix}@pawpal.test`, 'fixture-hash', userStatus, city, state]);
  const userId = users.rows[0].id;
  try {
    const shelters = await pool.query(`
      INSERT INTO shelters (owner_user_id,name,address_line,city,state,contact_email,verification_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [userId, `Fixture Shelter ${suffix}`, '100 Test Way', city, state, `contact_${suffix}@pawpal.test`, verified]);
    const shelterId = shelters.rows[0].id;
    const petIds = [];
    return {
      userId,
      shelterId,
      petIds,
      suffix,
      async pet(options = {}) {
        const data = {
          name: options.name ?? `Pet ${suffix}-${petIds.length + 1}`,
          species: options.species ?? 'dog',
          breed: options.breed ?? 'Mixed breed',
          ageMonths: options.ageMonths ?? 24,
          gender: options.gender ?? 'unknown',
          size: options.size ?? 'medium',
          energy: options.energy ?? 'medium',
          status: options.status ?? 'available',
          description: options.description ?? '',
          temperament: options.temperament ?? [],
          spayed: options.spayed ?? false,
          microchipped: options.microchipped ?? false,
          houseTrained: options.houseTrained ?? false,
          specialNeeds: options.specialNeeds ?? false,
          healthNotes: options.healthNotes ?? null,
          goodChildren: options.goodChildren ?? 'unknown',
          goodDogs: options.goodDogs ?? 'unknown',
          goodCats: options.goodCats ?? 'unknown',
        };
        const result = await pool.query(`
          INSERT INTO pets (shelter_id,name,species,breed,age_months,gender,size,energy_level,status,
                            description,temperament,spayed_neutered,microchipped,house_trained,
                            special_needs,health_notes,good_with_children,good_with_dogs,good_with_cats)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          RETURNING id
        `, [shelterId, data.name, data.species, data.breed, data.ageMonths, data.gender, data.size,
          data.energy, data.status, data.description, data.temperament, data.spayed, data.microchipped,
          data.houseTrained, data.specialNeeds, data.healthNotes, data.goodChildren, data.goodDogs, data.goodCats]);
        const id = result.rows[0].id;
        petIds.push(id);
        return id;
      },
      async photo(petId, { url = null, data = null, mimeType = null, position = 0, primary = true } = {}) {
        const result = await pool.query(`
          INSERT INTO pet_photos (pet_id,position,is_primary,url,data,mime_type,byte_size)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
        `, [petId, position, primary, url, data, mimeType, data?.length ?? null]);
        return result.rows[0].id;
      },
      async vaccination(petId, species, code, { givenOn = '2026-01-01', nextDueOn = null } = {}) {
        const vaccine = await pool.query('SELECT id FROM vaccine_types WHERE species=$1 AND code=$2', [species, code]);
        if (!vaccine.rows[0]) throw new Error(`Missing schema reference vaccine ${species}/${code}`);
        const result = await pool.query(`
          INSERT INTO pet_vaccinations (pet_id,vaccine_type_id,given_on,next_due_on)
          VALUES ($1,$2,$3,$4) RETURNING id
        `, [petId, vaccine.rows[0].id, givenOn, nextDueOn]);
        return result.rows[0].id;
      },
      async cleanup() {
        if (petIds.length) await pool.query('DELETE FROM pets WHERE id=ANY($1::uuid[])', [petIds]);
        await pool.query('DELETE FROM shelters WHERE id=$1', [shelterId]);
        if (!ownerUserId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
      },
    };
  } catch (error) {
    if (!ownerUserId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    throw error;
  }
}

export function newFixtureIdentity() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  return { name: `Adopter ${suffix}`, userCode: `adopter_${suffix}`, email: `adopter_${suffix}@pawpal.test`, password: 'PawPalTest123' };
}
