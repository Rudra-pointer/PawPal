import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DEMO_PHOTO_PROFILES } from '../server/src/db/demoPhotoProfiles.js';

const { Pool } = pg;
const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = path.join(ROOT, 'client', 'public', 'images', 'demo-pets');

if (!process.env.DATABASE_URL || process.env.NODE_ENV === 'test') {
  throw new Error('This targeted demo-photo script requires the development DATABASE_URL outside test mode.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const slug = filename => filename.replace(/\.webp$/, '');

try {
  const { rows: databaseRows } = await pool.query('SELECT current_database() AS name');
  if (databaseRows[0]?.name !== 'pawpal') throw new Error('Refusing to operate outside the pawpal development database.');
  const { rows: shelterRows } = await pool.query(`
    SELECT s.id
    FROM shelters s
    JOIN users u ON u.id=s.owner_user_id
    WHERE s.name=$1 AND s.verification_status='verified' AND u.status='active'
  `, ['Rose City Animal Shelter']);
  if (shelterRows.length !== 1) throw new Error('Expected one active, verified Rose City demo shelter.');

  const profiles = [];
  for (const profile of DEMO_PHOTO_PROFILES) {
    const asset = path.join(ASSET_DIR, profile.filename);
    const data = await fs.readFile(asset);
    const { rows } = await pool.query('SELECT name,species,source FROM pets WHERE source=$1 AND external_id=$2', ['seed', `demo-photo-v1:${slug(profile.filename)}`]);
    if (rows.length > 1) throw new Error(`Duplicate targeted demo profile key for ${profile.name}.`);
    if (rows.length === 1 && (rows[0].name !== profile.name || rows[0].species !== profile.species)) {
      throw new Error(`Existing targeted demo profile does not match manifest: ${profile.name}.`);
    }
    const collisions = await pool.query('SELECT id FROM pets WHERE lower(name)=lower($1) AND NOT (source=$2 AND external_id=$3)', [profile.name, 'seed', `demo-photo-v1:${slug(profile.filename)}`]);
    if (collisions.rowCount) throw new Error(`A pet already uses the target name ${profile.name}; no records were changed.`);
    profiles.push({ profile, data, exists: rows.length === 1 });
  }

  if (!APPLY) {
    console.log(JSON.stringify({ database: 'pawpal', mode: 'dry-run', profiles: profiles.length, photosToAdd: profiles.length }));
    process.exitCode = 0;
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: confirmRows } = await client.query('SELECT current_database() AS name');
      if (confirmRows[0]?.name !== 'pawpal') throw new Error('Database changed before transaction; refusing writes.');
      const { rows: shelter } = await client.query(`
        SELECT s.id FROM shelters s JOIN users u ON u.id=s.owner_user_id
        WHERE s.name=$1 AND s.verification_status='verified' AND u.status='active'
        FOR SHARE OF s, u
      `, ['Rose City Animal Shelter']);
      if (shelter.length !== 1) throw new Error('Demo shelter changed during preflight.');

      for (const { profile, data } of profiles) {
        const externalId = `demo-photo-v1:${slug(profile.filename)}`;
        const { rows } = await client.query(`
          INSERT INTO pets (shelter_id,name,species,breed,age_months,gender,size,description,temperament,energy_level,status,source,external_id,source_url)
          VALUES ($1,$2,$3,'Mixed breed',$4,'unknown',$5,$6,ARRAY['curious','social']::text[],$7,'available','seed',$8,$9)
          ON CONFLICT (source,external_id) WHERE external_id IS NOT NULL DO NOTHING
          RETURNING id
        `, [shelter[0].id, profile.name, profile.species, profile.ageMonths, profile.size, profile.description, profile.energy, externalId, profile.sourceUrl]);
        const pet = rows[0] ?? (await client.query('SELECT id FROM pets WHERE source=$1 AND external_id=$2', ['seed', externalId])).rows[0];
        if (!pet) throw new Error(`Could not resolve demo profile ${profile.name}.`);
        const existingPhotos = await client.query('SELECT data,mime_type,is_primary FROM pet_photos WHERE pet_id=$1', [pet.id]);
        if (existingPhotos.rowCount) {
          const same = existingPhotos.rowCount === 1 && existingPhotos.rows[0].is_primary && existingPhotos.rows[0].mime_type === 'image/webp' && Buffer.from(existingPhotos.rows[0].data).equals(data);
          if (!same) throw new Error(`A non-matching photo already exists for ${profile.name}; no existing photo will be replaced.`);
          continue;
        }
        await client.query(`
          INSERT INTO pet_photos (pet_id,position,is_primary,data,mime_type,byte_size)
          VALUES ($1,0,true,$2,'image/webp',$3)
        `, [pet.id, data, data.length]);
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ database: 'pawpal', mode: 'applied', profiles: profiles.length, photos: profiles.length }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} catch (error) {
  const connectionFailures = error?.errors?.map(item => `${item.code ?? 'connection error'}${item.address ? ` ${item.address}` : ''}`).join(', ');
  console.error(`Demo photo operation stopped safely: ${error?.message || connectionFailures || error?.code || 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
