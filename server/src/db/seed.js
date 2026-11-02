// server/src/db/seed.js
// Idempotent seed: running twice leaves counts unchanged.
// Usage: node server/src/db/seed.js
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { SEED_USERS, SEED_SHELTERS, SEED_APPLICATIONS } from './seedData.js';

const pool = new pg.Pool({
  connectionString: env.NODE_ENV === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL,
  max: 3,
  ssl: env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

const COST = env.NODE_ENV === 'production' ? 12 : 10;

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────
async function q(client, text, params) {
  return client.query(text, params);
}

async function hashPw(plain) {
  return bcrypt.hash(plain, COST);
}

// ─────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────
async function seedUsers(client, password) {
  const pw = await hashPw(password);

  const users = SEED_USERS;;

  const ids = {};
  for (const u of users) {
    const { rows } = await q(client,
      `INSERT INTO users (user_code, name, email, password_hash, role, city, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (lower(email)) DO UPDATE SET user_code = users.user_code
       RETURNING id, user_code`,
      [u.user_code, u.name, u.email, pw, u.role, u.city, u.state]
    );
    ids[u.user_code] = rows[0].id;
  }
  return ids;
}

// ─────────────────────────────────────────────
// SHELTERS
// ─────────────────────────────────────────────
async function seedShelters(client, userIds, adminId) {
  const shelters = SEED_SHELTERS;;

  const ids = {};
  for (const s of shelters) {
    const ownerId = userIds[s.owner];
    const { rows } = await q(client,
      `INSERT INTO shelters
         (owner_user_id, name, description, address_line, city, state, postcode,
          contact_email, contact_phone, website, verification_status,
          verified_by, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               CASE WHEN $11::verification_state = 'verified' THEN now() ELSE NULL END)
       ON CONFLICT (owner_user_id) DO UPDATE SET name = shelters.name
       RETURNING id, name`,
      [
        ownerId, s.name, s.description, s.address_line, s.city, s.state, s.postcode,
        s.contact_email, s.contact_phone, s.website, s.verification_status,
        s.verification_status === 'verified' ? adminId : null,
      ]
    );
    ids[s.owner] = rows[0].id;
  }
  return ids;
}

// ─────────────────────────────────────────────
// PETS helpers
// ─────────────────────────────────────────────
async function insertPet(client, p) {
  const { rows: existingSeedPet } = await q(client,
    `SELECT id FROM pets
     WHERE lower(name) = lower($1) AND shelter_id = $2 AND source = 'seed'
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [p.name, p.shelter_id]
  );
  if (existingSeedPet.length) return existingSeedPet[0].id;

  const { rows } = await q(client,
    `INSERT INTO pets
       (shelter_id, name, species, breed, age_months, gender, size, weight_kg,
        coat, colors, description, temperament, energy_level,
        spayed_neutered, microchipped, house_trained,
        special_needs, special_needs_notes, health_notes,
        good_with_children, good_with_dogs, good_with_cats,
        status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'seed')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      p.shelter_id, p.name, p.species, p.breed, p.age_months, p.gender, p.size,
      p.weight_kg ?? null, p.coat ?? null, p.colors ?? [], p.description,
      p.temperament ?? [], p.energy_level,
      p.spayed_neutered ?? true, p.microchipped ?? false, p.house_trained ?? false,
      p.special_needs ?? false, p.special_needs_notes ?? null, p.health_notes ?? null,
      p.good_with_children ?? 'unknown', p.good_with_dogs ?? 'unknown', p.good_with_cats ?? 'unknown',
      p.status ?? 'available',
    ]
  );
  if (rows.length === 0) {
    // Already exists — fetch its id
    const { rows: existing } = await q(client,
      `SELECT id FROM pets WHERE lower(name) = lower($1) AND shelter_id = $2 AND source = 'seed'`,
      [p.name, p.shelter_id]
    );
    return existing[0]?.id ?? null;
  }
  return rows[0].id;
}

async function insertPhoto(client, petId, url, position = 0) {
  await q(client,
    `INSERT INTO pet_photos (pet_id, position, is_primary, url)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [petId, position, position === 0, url]
  );
}

// ─────────────────────────────────────────────
// VACCINES
// ─────────────────────────────────────────────
async function getVaccineTypes(client) {
  const { rows } = await q(client, 'SELECT id, species, code FROM vaccine_types');
  const map = {};
  for (const r of rows) {
    if (!map[r.species]) map[r.species] = {};
    map[r.species][r.code] = r.id;
  }
  return map;
}

async function insertVaccination(client, petId, vaccineTypeId, givenOn, nextDueOn, clinic, notes) {
  await q(client,
    `INSERT INTO pet_vaccinations (pet_id, vaccine_type_id, given_on, next_due_on, clinic, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (pet_id, vaccine_type_id, given_on) DO NOTHING`,
    [petId, vaccineTypeId, givenOn, nextDueOn ?? null, clinic ?? null, notes ?? null]
  );
}

// date helpers
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────
// PETS — main definition array
// ─────────────────────────────────────────────
export function buildPets(shelterIds) {
  const rose     = shelterIds['rose_owner'];
  const lonestar = shelterIds['lonestar_owner'];
  const emerald  = shelterIds['emerald_owner'];
  // Mile High (pending) has no pets intentionally

  // ── HTML-derived pets (8 exact from pets=[] array, 4 canonical extras) ──
  const htmlPets = [
    // 1
    {
      shelter_id: rose, name: 'Biscuit', species: 'dog', breed: 'Golden Retriever Mix',
      age_months: 24, gender: 'male', size: 'medium', weight_kg: 22.0,
      coat: 'medium wavy', colors: ['golden', 'cream'],
      description: 'Biscuit is a sunny, tail-wagging goofball who greets everyone like a long-lost friend. He loves fetch, muddy puddles, and snoozing on the sofa after a long walk.',
      temperament: ['playful', 'social', 'affectionate', 'loyal'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=700&q=80',
    },
    // 2
    {
      shelter_id: rose, name: 'Miso', species: 'cat', breed: 'Tabby',
      age_months: 36, gender: 'female', size: 'small', weight_kg: 3.8,
      coat: 'short', colors: ['orange', 'white'],
      description: 'Miso chirps softly when she wants attention and purrs like a motorboat the moment you sit down. She is confident with calm adults and curious about windows and birds.',
      temperament: ['curious', 'vocal', 'affectionate', 'independent'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=700&q=80',
    },
    // 3
    {
      shelter_id: lonestar, name: 'Waffles', species: 'dog', breed: 'Pug',
      age_months: 48, gender: 'male', size: 'small', weight_kg: 8.5,
      coat: 'short', colors: ['fawn', 'black'],
      description: 'Waffles is a laid-back charmer who would rather nap on a lap than run a marathon. He does well in apartments, loves short strolls, and is devoted to anyone who shares their blanket.',
      temperament: ['calm', 'cuddly', 'loyal', 'social'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1517849845537-4d257902454a?auto=format&fit=crop&w=700&q=80',
    },
    // 4
    {
      shelter_id: emerald, name: 'Luna', species: 'cat', breed: 'Siamese',
      age_months: 60, gender: 'female', size: 'small', weight_kg: 4.1,
      coat: 'short', colors: ['cream', 'seal point'],
      description: 'Luna has a lot to say and is not shy about saying it. She bonds deeply with one person, follows them from room to room, and demands top billing on every lap in the house.',
      temperament: ['vocal', 'affectionate', 'loyal', 'independent'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1592194996308-7b43878e84a6?auto=format&fit=crop&w=700&q=80',
    },
    // 5
    {
      shelter_id: lonestar, name: 'Ziggy', species: 'dog', breed: 'Beagle',
      age_months: 14, gender: 'male', size: 'medium', weight_kg: 11.0,
      coat: 'short', colors: ['tricolor', 'brown', 'white', 'black'],
      description: 'Ziggy\'s nose is always busy investigating the world. He is enthusiastic on walks, excellent with kids, and responds well to treat-based training once he decides you are worth listening to.',
      temperament: ['curious', 'playful', 'social', 'food_motivated', 'trainable'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=700&q=80',
    },
    // 6
    {
      shelter_id: lonestar, name: 'Maple', species: 'dog', breed: 'Corgi Mix',
      age_months: 24, gender: 'female', size: 'medium', weight_kg: 13.5,
      coat: 'medium double coat', colors: ['sable', 'white'],
      description: 'Maple has the herding dog\'s alertness paired with a warm, comedic personality. She zooms in the yard, then curls into a tidy circle on her bed and sleeps like she has earned it.',
      temperament: ['energetic', 'playful', 'affectionate', 'trainable'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1537151625747-768eb6cf92b2?auto=format&fit=crop&w=700&q=80',
    },
    // 7
    {
      shelter_id: rose, name: 'Clover', species: 'rabbit', breed: 'Holland Lop',
      age_months: 8, gender: 'female', size: 'small', weight_kg: 1.8,
      coat: 'short plush', colors: ['grey', 'white'],
      description: 'Clover binkies across the room when she\'s happy and nudges your hand for forehead pets. She is litter-trained, loves leafy greens, and enjoys a cardboard maze to explore at dusk.',
      temperament: ['curious', 'gentle', 'playful', 'social'],
      energy_level: 'medium', spayed_neutered: false, microchipped: false, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1585110396000-c9ffd4e4b308?auto=format&fit=crop&w=700&q=80',
    },
    // 8 — senior dog
    {
      shelter_id: lonestar, name: 'Rocky', species: 'dog', breed: 'Golden Retriever',
      age_months: 108, gender: 'male', size: 'large', weight_kg: 34.0,
      coat: 'long double coat', colors: ['golden'],
      description: 'Rocky has the gentle confidence of a dog who has seen a lot and loved even more. He enjoys slow morning walks, sunlit naps, and treats earned by doing absolutely nothing at all.',
      temperament: ['calm', 'gentle', 'affectionate', 'loyal'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1477884213360-7e9d7dcc1e48?auto=format&fit=crop&w=700&q=80',
    },
    // 9 — canonical extra rabbit (Bun, from heroPets)
    {
      shelter_id: rose, name: 'Bun', species: 'rabbit', breed: 'Mini Rex',
      age_months: 10, gender: 'male', size: 'small', weight_kg: 1.6,
      coat: 'short velvety', colors: ['chocolate', 'white'],
      description: 'Bun has the softest fur you will ever pet, and he knows it. He thumps energetically when excited and loves a good chin scratch after his evening salad.',
      temperament: ['curious', 'social', 'gentle'],
      energy_level: 'medium', spayed_neutered: false, microchipped: false, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1589924691995-400dc9ecc119?auto=format&fit=crop&w=700&q=80',
    },
    // 10 — canonical extra cat
    {
      shelter_id: emerald, name: 'Pepper', species: 'cat', breed: 'Russian Blue',
      age_months: 14, gender: 'female', size: 'small', weight_kg: 3.5,
      coat: 'short dense', colors: ['blue-grey'],
      description: 'Pepper is quietly observant and choosy with her affection, but once she trusts you there is no better lap companion. She plays hard for twenty minutes, then sleeps for three hours.',
      temperament: ['independent', 'shy', 'affectionate', 'quiet'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1594955209289-be4c5d15d921?auto=format&fit=crop&w=700&q=80',
    },
    // 11 — canonical extra dog
    {
      shelter_id: lonestar, name: 'Scout', species: 'dog', breed: 'Border Collie',
      age_months: 18, gender: 'male', size: 'medium', weight_kg: 18.0,
      coat: 'medium double coat', colors: ['black', 'white'],
      description: 'Scout is the kind of dog who will outsmart you if you don\'t keep him busy. He thrives with a job — agility, fetch, or learning new commands — and adores an active family who matches his drive.',
      temperament: ['energetic', 'trainable', 'loyal', 'playful', 'curious'],
      energy_level: 'high', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'no',
      img: 'https://images.unsplash.com/photo-1503256207526-0d5523f39b32?auto=format&fit=crop&w=700&q=80',
    },
    // 12 — canonical extra rabbit (baby, will be bonded with Clover)
    {
      shelter_id: rose, name: 'Hazel', species: 'rabbit', breed: 'Lionhead',
      age_months: 6, gender: 'female', size: 'small', weight_kg: 1.4,
      coat: 'wooly mane', colors: ['white', 'grey'],
      description: 'Hazel is a tiny fluffball with an enormous personality. She periscopes up to investigate every sound, binkies when let out for run time, and rests with Clover for warmth and company.',
      temperament: ['curious', 'playful', 'gentle'],
      energy_level: 'medium', spayed_neutered: false, microchipped: false, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1612088244959-43f4f60c9abe?auto=format&fit=crop&w=700&q=80',
    },
  ];

  // ── 24 NEW realistic pets ──
  const newPets = [
    // DOGS (8 more → total 16 dogs with HTML 8)
    // 13 — puppy under 12 mo, not spayed
    {
      shelter_id: lonestar, name: 'Daisy', species: 'dog', breed: 'Labrador Retriever',
      age_months: 10, gender: 'female', size: 'large', weight_kg: 22.0,
      coat: 'short', colors: ['yellow'],
      description: 'Daisy is all paws and enthusiasm, bounding through life with the joy of a puppy who hasn\'t learned self-restraint yet. She is smart, treat-motivated, and learning something new every single day.',
      temperament: ['playful', 'food_motivated', 'trainable', 'energetic', 'social'],
      energy_level: 'high', spayed_neutered: false, microchipped: true, house_trained: false,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1611003228941-98852ba62227?auto=format&fit=crop&w=700&q=80',
    },
    // 14 — adult dog, trained
    {
      shelter_id: rose, name: 'Bruno', species: 'dog', breed: 'German Shepherd',
      age_months: 72, gender: 'male', size: 'large', weight_kg: 35.0,
      coat: 'medium double coat', colors: ['black', 'tan'],
      description: 'Bruno is calm, attentive and quietly protective of the people he loves. He passed basic and advanced obedience classes and walks beautifully on leash in any weather.',
      temperament: ['loyal', 'protective', 'trainable', 'calm', 'gentle'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'no',
      img: 'https://images.unsplash.com/photo-1589941013453-ec89f33b5e95?auto=format&fit=crop&w=700&q=80',
    },
    // 15 — senior small dog
    {
      shelter_id: emerald, name: 'Cleo', species: 'dog', breed: 'Chihuahua',
      age_months: 144, gender: 'female', size: 'small', weight_kg: 2.8,
      coat: 'short', colors: ['fawn', 'white'],
      description: 'Cleo has twelve years of bossiness perfected into an art form. She prefers a quiet home, a warm lap, and being the unquestioned centre of the universe from Monday through Sunday.',
      temperament: ['calm', 'independent', 'loyal', 'protective'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'no', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&w=700&q=80',
    },
    // 16 — young herding mix
    {
      shelter_id: rose, name: 'Nala', species: 'dog', breed: 'Australian Shepherd',
      age_months: 30, gender: 'female', size: 'medium', weight_kg: 20.0,
      coat: 'medium wavy merle', colors: ['blue merle', 'white', 'tan'],
      description: 'Nala is a vivid, eye-catching Aussie who loves nothing more than running full speed in an open yard then flopping dramatically at your feet. She learns tricks in minutes and never tires of them.',
      temperament: ['energetic', 'trainable', 'playful', 'loyal', 'social'],
      energy_level: 'high', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1508532566027-b2032cd8a715?auto=format&fit=crop&w=700&q=80',
    },
    // 17 — senior large dog, special needs
    {
      shelter_id: lonestar, name: 'Rex', species: 'dog', breed: 'Rottweiler',
      age_months: 120, gender: 'male', size: 'large', weight_kg: 44.0,
      coat: 'short', colors: ['black', 'mahogany'],
      description: 'Rex is a dignified old gentleman who moves a little slower these days but still has the warmest eyes in the room. He is gentle with everyone he meets and sleeps through thunderstorms unbothered.',
      temperament: ['calm', 'gentle', 'loyal', 'affectionate'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      special_needs: true, special_needs_notes: 'Mild hip dysplasia — managed with joint supplements and low-impact walks. No stairs ideally.',
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=700&q=80',
    },
    // 18 — young small dog
    {
      shelter_id: emerald, name: 'Finn', species: 'dog', breed: 'Dachshund',
      age_months: 28, gender: 'male', size: 'small', weight_kg: 8.2,
      coat: 'smooth short', colors: ['chocolate', 'tan'],
      description: 'Finn is a determined little sausage with a big-dog attitude. He loves sniffing every inch of a trail, digging in the garden, and burrowing under blankets at the end of the day.',
      temperament: ['curious', 'playful', 'loyal', 'independent'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=700&q=80',
    },
    // 19 — puppy under 12 mo (baby), not spayed
    {
      shelter_id: rose, name: 'Stella', species: 'dog', breed: 'Boxer',
      age_months: 8, gender: 'female', size: 'medium', weight_kg: 14.0,
      coat: 'short', colors: ['fawn', 'white', 'black mask'],
      description: 'Stella is pure joy in a wiggly package. She bounces off the walls, topples into laps, and wags her stubby tail so hard her whole back half wobbles. Puppy classes are strongly recommended.',
      temperament: ['playful', 'energetic', 'social', 'affectionate'],
      energy_level: 'high', spayed_neutered: false, microchipped: true, house_trained: false,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1607346256330-dee7af15f7c5?auto=format&fit=crop&w=700&q=80',
    },
    // 20 — adult small/low energy dog
    {
      shelter_id: lonestar, name: 'Archie', species: 'dog', breed: 'French Bulldog',
      age_months: 60, gender: 'male', size: 'small', weight_kg: 11.0,
      coat: 'short smooth', colors: ['brindle', 'white'],
      description: 'Archie is the master of the dramatic sigh and the expert napper. He loves short walks, long belly rubs, and keeping you company from his favourite corner of the sofa at all hours.',
      temperament: ['calm', 'affectionate', 'cuddly', 'social'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=700&q=80',
    },
    // CATS (6 more → total 10 cats with HTML 4, then 2 bonded kittens = 12 → 14 total)
    // 21 — adult large cat
    {
      shelter_id: rose, name: 'Oliver', species: 'cat', breed: 'Maine Coon',
      age_months: 84, gender: 'male', size: 'medium', weight_kg: 6.8,
      coat: 'long shaggy tufted', colors: ['brown tabby', 'white'],
      description: 'Oliver is a magnificent, dog-like Maine Coon who greets you at the door, chirps conversationally, and accepts chin scratches with the quiet dignity of a cat who knows he is exceptional.',
      temperament: ['social', 'gentle', 'curious', 'affectionate', 'vocal'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1574158622682-e40e69881006?auto=format&fit=crop&w=700&q=80',
    },
    // 22 — senior cat, special needs
    {
      shelter_id: emerald, name: 'Duchess', species: 'cat', breed: 'Persian',
      age_months: 132, gender: 'female', size: 'small', weight_kg: 3.9,
      coat: 'long silky', colors: ['white', 'cream'],
      description: 'Duchess floats into a room like royalty and settles wherever the sun patch is warmest. She is gentle, unhurried, and endlessly decorative — the ideal companion for a calm, quiet household.',
      temperament: ['calm', 'gentle', 'quiet', 'independent', 'affectionate'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      special_needs: true, special_needs_notes: 'Requires daily brushing and monthly professional grooming. Periodic dental check-ups due to brachycephalic teeth crowding.',
      good_with_children: 'no', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1571566882372-1598d88abd90?auto=format&fit=crop&w=700&q=80',
    },
    // 23 — young energetic cat
    {
      shelter_id: lonestar, name: 'Leo', species: 'cat', breed: 'Bengal',
      age_months: 14, gender: 'male', size: 'medium', weight_kg: 4.8,
      coat: 'short spotted', colors: ['brown', 'gold', 'black spots'],
      description: 'Leo is an athletic, wild-looking cat who leaps to the highest shelf in seconds and expects you to be impressed. Interactive toys, puzzle feeders, and vertical space are non-negotiable for him.',
      temperament: ['energetic', 'playful', 'curious', 'vocal', 'trainable'],
      energy_level: 'high', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1513245543132-31f507417b26?auto=format&fit=crop&w=700&q=80',
    },
    // 24 — adult calm Ragdoll
    {
      shelter_id: emerald, name: 'Willow', species: 'cat', breed: 'Ragdoll',
      age_months: 60, gender: 'female', size: 'medium', weight_kg: 5.1,
      coat: 'semi-long plush pointed', colors: ['blue point', 'white'],
      description: 'Willow goes limp with contentment the moment you lift her — the ultimate floor cat. She follows you from room to room, waits patiently outside closed doors, and purrs on a hair trigger.',
      temperament: ['calm', 'cuddly', 'affectionate', 'gentle', 'social'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1533743983669-94fa5c4338ec?auto=format&fit=crop&w=700&q=80',
    },
    // 25 — senior tabby
    {
      shelter_id: rose, name: 'Zara', species: 'cat', breed: 'Calico',
      age_months: 144, gender: 'female', size: 'small', weight_kg: 3.6,
      coat: 'short', colors: ['orange', 'black', 'white'],
      description: 'Zara has twelve years of strong opinions and still voices every single one. She naps in sunbeams, tolerates petting on her own schedule, and is reliably affectionate with the patient and the quiet.',
      temperament: ['independent', 'calm', 'affectionate', 'quiet'],
      energy_level: 'low', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1597626133663-53df9633b799?auto=format&fit=crop&w=700&q=80',
    },
    // 26 — adult energetic Abyssinian
    {
      shelter_id: lonestar, name: 'Nora', species: 'cat', breed: 'Abyssinian',
      age_months: 48, gender: 'female', size: 'small', weight_kg: 3.7,
      coat: 'short ticked', colors: ['ruddy', 'orange'],
      description: 'Nora is a whippet-fast cat who treats your home like an obstacle course and your hands like playthings. She is endlessly entertaining, highly interactive, and keeps even remote workers on their toes.',
      temperament: ['energetic', 'playful', 'curious', 'social', 'trainable'],
      energy_level: 'high', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1548247416-ec66f4900b2e?auto=format&fit=crop&w=700&q=80',
    },
    // 27 — kitten, baby, bonded pair (with Dot), not neutered
    {
      shelter_id: emerald, name: 'Pip', species: 'cat', breed: 'Domestic Shorthair',
      age_months: 3, gender: 'male', size: 'small', weight_kg: 0.7,
      coat: 'short', colors: ['black', 'white'],
      description: 'Pip and his sister Dot came in together and have never spent a night apart. He is the bold one — first to explore, first to pounce — and he needs Dot\'s company to feel truly at home.',
      temperament: ['playful', 'curious', 'social', 'energetic'],
      energy_level: 'high', spayed_neutered: false, microchipped: false, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1561948955-570b270e7c36?auto=format&fit=crop&w=700&q=80',
      _bondKey: 'pip_dot',
    },
    // 28 — kitten, baby, bonded pair (with Pip), not neutered
    {
      shelter_id: emerald, name: 'Dot', species: 'cat', breed: 'Domestic Shorthair',
      age_months: 3, gender: 'female', size: 'small', weight_kg: 0.6,
      coat: 'short', colors: ['white', 'black spots'],
      description: 'Dot is Pip\'s quieter, watchful sister. She hangs back just long enough to assess a situation, then launches herself in with the same reckless kitten abandon. Adopt them together for twice the joy.',
      temperament: ['curious', 'playful', 'gentle', 'social'],
      energy_level: 'high', spayed_neutered: false, microchipped: false, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1568152950566-7b33e7a42d4c?auto=format&fit=crop&w=700&q=80',
      _bondKey: 'pip_dot',
    },
    // RABBITS (4 more → total 6 rabbits)
    // 29 — young Dutch rabbit
    {
      shelter_id: rose, name: 'Cinnamon', species: 'rabbit', breed: 'Dutch',
      age_months: 18, gender: 'female', size: 'small', weight_kg: 2.1,
      coat: 'short', colors: ['cinnamon', 'white'],
      description: 'Cinnamon has a bold stripe of warm auburn against bright white and a personality to match. She runs laps at dusk, forages her hay pile with theatrical energy, and settles into curious observation by day.',
      temperament: ['curious', 'playful', 'social', 'gentle'],
      energy_level: 'medium', spayed_neutered: true, microchipped: false, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1518715303843-586e350831cf?auto=format&fit=crop&w=700&q=80',
    },
    // 30 — large adult rabbit, gentle
    {
      shelter_id: lonestar, name: 'Thumper', species: 'rabbit', breed: 'Flemish Giant',
      age_months: 30, gender: 'male', size: 'large', weight_kg: 7.2,
      coat: 'short dense', colors: ['grey', 'sandy'],
      description: 'Thumper is a grand, relaxed rabbit who sprawls out like a small furry rug and accepts petting with serene dignity. He is calm enough for a gentle household and bonds quickly once he trusts you.',
      temperament: ['calm', 'gentle', 'social', 'affectionate'],
      energy_level: 'low', spayed_neutered: true, microchipped: false, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1452857576997-f0132690d0de?auto=format&fit=crop&w=700&q=80',
    },
    // 31 — senior rabbit, special needs
    {
      shelter_id: emerald, name: 'Basil', species: 'rabbit', breed: 'Angora',
      age_months: 80, gender: 'male', size: 'medium', weight_kg: 3.1,
      coat: 'long wooly', colors: ['white', 'grey'],
      description: 'Basil is a fluffy, thoughtful senior who has slowed his pace and perfected the art of loafing in a sunbeam. He loves gentle grooming sessions and quiet evenings with a calm, attentive adopter.',
      temperament: ['calm', 'gentle', 'quiet', 'affectionate'],
      energy_level: 'low', spayed_neutered: true, microchipped: false, house_trained: true,
      special_needs: true, special_needs_notes: 'Requires daily grooming to prevent wool block. Every 6–8 weeks professional trim recommended. Dental checks every 6 months.',
      good_with_children: 'no', good_with_dogs: 'no', good_with_cats: 'unknown',
      img: 'https://images.unsplash.com/photo-1554671534-0d2d5c1e9ec0?auto=format&fit=crop&w=700&q=80',
    },
    // 32 — young dwarf rabbit, bonded pair (with Reed)
    {
      shelter_id: rose, name: 'Fern', species: 'rabbit', breed: 'Netherland Dwarf',
      age_months: 5, gender: 'female', size: 'small', weight_kg: 0.9,
      coat: 'short', colors: ['agouti', 'grey'],
      description: 'Fern is a tiny, curious rabbit who dashes around her pen investigating everything with bright dark eyes. She and Reed snuggle every night and groom each other after breakfast — they are a bonded pair.',
      temperament: ['curious', 'playful', 'gentle', 'social'],
      energy_level: 'medium', spayed_neutered: false, microchipped: false, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'no',
      img: 'https://images.unsplash.com/photo-1585110396000-c9ffd4e4b308?auto=format&fit=crop&w=700&q=80',
      _bondKey: 'fern_reed',
    },
    // 33 — young dwarf rabbit, bonded pair (with Fern)
    {
      shelter_id: rose, name: 'Reed', species: 'rabbit', breed: 'Netherland Dwarf',
      age_months: 5, gender: 'male', size: 'small', weight_kg: 1.0,
      coat: 'short', colors: ['white', 'grey'],
      description: 'Reed is the calmer half of the pair, often found stretched out beside Fern while she investigates everything. He is the first to flop in contentment and the first to thump if he hears something new.',
      temperament: ['calm', 'curious', 'gentle', 'social'],
      energy_level: 'medium', spayed_neutered: false, microchipped: false, house_trained: true,
      good_with_children: 'unknown', good_with_dogs: 'no', good_with_cats: 'no',
      img: 'https://images.unsplash.com/photo-1589924691995-400dc9ecc119?auto=format&fit=crop&w=700&q=80',
      _bondKey: 'fern_reed',
    },
    // REMAINING DOGS to reach exactly 16 dogs total
    // 34 — young large dog
    {
      shelter_id: emerald, name: 'Bear', species: 'dog', breed: 'Bernese Mountain Dog',
      age_months: 36, gender: 'male', size: 'large', weight_kg: 42.0,
      coat: 'long tricolor', colors: ['black', 'white', 'rust'],
      description: 'Bear is a gentle giant who loves cool weather, snowy walks, and sitting on your feet. He is patient and steady with everyone he meets, and his tail never stops wagging when children are around.',
      temperament: ['calm', 'gentle', 'affectionate', 'loyal', 'social'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1530281700549-e82e7bf110d6?auto=format&fit=crop&w=700&q=80',
    },
    // 35 — young energetic dog
    {
      shelter_id: lonestar, name: 'Penny', species: 'dog', breed: 'Jack Russell Terrier',
      age_months: 20, gender: 'female', size: 'small', weight_kg: 5.8,
      coat: 'smooth short', colors: ['white', 'tan'],
      description: 'Penny is an eleven-kilogram ball of opinions who has never met a challenge she wasn\'t ready to tackle head-on. She excels at agility, loves digging, and requires a confident owner who enjoys an active lifestyle.',
      temperament: ['energetic', 'playful', 'curious', 'loyal', 'trainable'],
      energy_level: 'high', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'unknown', good_with_cats: 'no',
      img: 'https://images.unsplash.com/photo-1576201836106-db1758fd1c97?auto=format&fit=crop&w=700&q=80',
    },
    // 36 — adult mixed breed dog (to reach 36 total)
    {
      shelter_id: rose, name: 'Max', species: 'dog', breed: 'Mixed Breed',
      age_months: 54, gender: 'male', size: 'medium', weight_kg: 19.5,
      coat: 'short', colors: ['brindle', 'brown'],
      description: 'Max is a steady, easygoing dog who fits into any household routine like he has lived there for years. He enjoys a morning run as much as a rainy-day snuggle and never causes unnecessary drama.',
      temperament: ['calm', 'affectionate', 'loyal', 'trainable', 'social'],
      energy_level: 'medium', spayed_neutered: true, microchipped: true, house_trained: true,
      good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
      img: 'https://images.unsplash.com/photo-1596492784531-6e6eb5ea9993?auto=format&fit=crop&w=700&q=80',
    },
  ];

  const pets = [...htmlPets, ...newPets];
  const makeCat = (name, breed, description, temperament) => {
    const pet = pets.find(item => item.name === name);
    Object.assign(pet, { species: 'cat', breed, size: 'medium', house_trained: true,
      description, temperament, energy_level: 'medium', good_with_cats: 'unknown' });
  };
  const makeDog = (name, breed, description, temperament) => {
    const pet = pets.find(item => item.name === name);
    Object.assign(pet, { species: 'dog', breed, size: 'small', house_trained: true,
      description, temperament, energy_level: 'medium', good_with_dogs: 'unknown' });
  };
  makeCat('Bear', 'Maine Coon', 'Bear is a gentle, curious cat who enjoys a sunny window and patient company. He warms up at his own pace, then follows his people from room to room.', ['gentle','curious','affectionate']);
  makeCat('Penny', 'Domestic Shorthair', 'Penny is an observant, affectionate cat who likes quiet play and a soft place nearby. She is happiest when introductions are calm and her routine is predictable.', ['calm','affectionate','curious']);
  makeCat('Max', 'Ragdoll Mix', 'Max is a sociable cat who greets familiar people with a soft chirp and settles close by. He enjoys a little play before a long afternoon nap.', ['social','playful','cuddly']);
  makeDog('Cinnamon', 'Miniature Pinscher Mix', 'Cinnamon is an alert, bright little dog who loves sniffing walks and learning small tricks. She settles well after activity and enjoys staying close to her people.', ['curious','playful','trainable']);
  makeDog('Thumper', 'Dachshund Mix', 'Thumper is an easygoing small dog who enjoys relaxed walks and a cozy bed. He is gentle with familiar people and likes a steady daily routine.', ['calm','gentle','loyal']);
  return pets;
}

// ─────────────────────────────────────────────
// VACCINES — assign per pet based on age + species
// ─────────────────────────────────────────────
async function seedVaccines(client, pets, vaccineTypes) {
  const today = new Date();

  for (const { id, species, age_months, name } of pets) {
    if (!id) continue;
    const vt = vaccineTypes[species];
    if (!vt) continue;

    if (species === 'dog') {
      if (age_months <= 4) {
        // Very young puppy: only first DHPP dose
        if (vt.DHPP) {
          await insertVaccination(client, id, vt.DHPP,
            daysAgo(Math.floor(age_months * 30 * 0.6)),
            daysFromNow(21), 'PawPal Vet Clinic', 'First DHPP dose (6-week series)');
        }
      } else if (age_months < 12) {
        // Puppy: DHPP series in progress, no rabies yet
        if (vt.DHPP) {
          await insertVaccination(client, id, vt.DHPP,
            daysAgo(30), daysFromNow(21), 'PawPal Vet Clinic', 'DHPP booster — series in progress');
        }
      } else {
        // Adult/senior dog: rabies + DHPP
        const rabiesDaysAgo = age_months >= 96 ? 180 : 90;
        const dhppDaysAgo   = age_months >= 96 ? 200 : 60;
        const overdue = age_months >= 120; // some seniors are overdue

        if (vt.RABIES) {
          await insertVaccination(client, id, vt.RABIES,
            daysAgo(rabiesDaysAgo),
            overdue ? daysAgo(30) : daysFromNow(300), // overdue = next_due in past
            'City Animal Clinic', overdue ? 'Overdue — please schedule booster' : null);
        }
        if (vt.DHPP) {
          await insertVaccination(client, id, vt.DHPP,
            daysAgo(dhppDaysAgo),
            overdue ? daysAgo(10) : daysFromNow(365),
            'City Animal Clinic', null);
        }
      }
    } else if (species === 'cat') {
      if (age_months < 4) {
        // Kitten: first FVRCP
        if (vt.FVRCP) {
          await insertVaccination(client, id, vt.FVRCP,
            daysAgo(21), daysFromNow(21), 'Emerald Vet', 'First FVRCP dose');
        }
      } else if (age_months < 12) {
        if (vt.FVRCP) {
          await insertVaccination(client, id, vt.FVRCP,
            daysAgo(30), daysFromNow(21), 'Emerald Vet', 'FVRCP booster');
        }
      } else {
        const overdue = age_months >= 132;
        if (vt.RABIES) {
          await insertVaccination(client, id, vt.RABIES,
            daysAgo(100), overdue ? daysAgo(60) : daysFromNow(265),
            'Emerald Vet', null);
        }
        if (vt.FVRCP) {
          await insertVaccination(client, id, vt.FVRCP,
            daysAgo(90), overdue ? daysAgo(5) : daysFromNow(275),
            'Emerald Vet', null);
        }
      }
    } else if (species === 'rabbit') {
      // Region-dependent — record RHDV2 for adults if available
      if (age_months >= 12 && vt.RHDV2) {
        await insertVaccination(client, id, vt.RHDV2,
          daysAgo(120), daysFromNow(245), 'Rabbit-Savvy Vet', null);
      }
    }
  }
}

// ─────────────────────────────────────────────
// APPLICATIONS
// ─────────────────────────────────────────────
async function seedApplications(client, userIds, petMap) {
  // petMap: name -> { id, shelter_id, status }
  const apps = SEED_APPLICATIONS;;

  const statusTimestamps = {
    submitted:    'submitted_at',
    under_review: 'reviewed_at',
    approved:     'decided_at',
    rejected:     'decided_at',
    completed:    'completed_at',
  };

  for (const app of apps) {
    const pet = petMap[app.petName];
    if (!pet) { console.warn(`  ⚠ Pet not found for application: ${app.petName}`); continue; }

    const adopterId = userIds[app.adopter];

    // Check if application already exists
    const { rows: existing } = await q(client,
      `SELECT id FROM applications WHERE pet_id=$1 AND adopter_id=$2`,
      [pet.id, adopterId]
    );
    if (existing.length > 0) continue;

    // Determine timestamps
    const now = new Date();
    const submittedAt  = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
    const reviewedAt   = new Date(now.getTime() -  7 * 24 * 3600 * 1000);
    const decidedAt    = new Date(now.getTime() -  3 * 24 * 3600 * 1000);
    const completedAt  = new Date(now.getTime() -  1 * 24 * 3600 * 1000);

    const ts = app.finalStatus === 'submitted'
      ? [null, null, null]
      : app.finalStatus === 'under_review'
      ? [reviewedAt, null, null]
      : app.finalStatus === 'completed'
      ? [reviewedAt, decidedAt, completedAt]
      : [reviewedAt, decidedAt, null];

    const { rows: [row] } = await q(client,
      `INSERT INTO applications
         (pet_id, adopter_id, status,
          applicant_name, applicant_email, contact_no,
          address_line, city, state, postcode,
          home_type, ownership,
          household_adults, has_children, youngest_child_age, other_pets,
          experience, hours_alone_per_day, reason, decision_note,
          submitted_at, reviewed_at, decided_at, completed_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        pet.id, adopterId, app.finalStatus,
        app.name, app.email, app.phone,
        app.address, app.city, app.state ?? null, app.postcode ?? null,
        app.home_type, app.ownership,
        app.adults, app.has_children ?? false, app.youngest_child_age ?? null, app.other_pets ?? '',
        app.experience, app.hours_alone, app.reason, app.decision_note ?? null,
        submittedAt, ts[0], ts[1], ts[2],
      ]
    );

    if (!row) continue;
    const appId = row.id;

    // Events
    let prevStatus = null;
    const eventTimes = [submittedAt, reviewedAt, decidedAt, completedAt];
    for (let i = 0; i < app.events.length; i++) {
      const toStatus = app.events[i];
      await q(client,
        `INSERT INTO application_events (application_id, from_status, to_status, actor_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [appId, prevStatus, toStatus, adopterId, eventTimes[i]]
      );
      prevStatus = toStatus;
    }

    // Checks
    for (const chk of (app.checks ?? [])) {
      await q(client,
        `INSERT INTO application_checks (application_id, check_type, result, checked_at, checked_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (application_id, check_type) DO NOTHING`,
        [appId, chk.type, chk.result,
          chk.result !== 'pending' ? decidedAt : null,
          chk.result !== 'pending' ? userIds[app.adopter === 'alex' ? 'rose_owner' : app.adopter === 'jamie' ? 'lonestar_owner' : 'emerald_owner'] : null]
      );
    }
  }
}

// ─────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────
async function seedReports(client, userIds, petMap) {
  const reports = [
    {
      reporterId: userIds['alex'], targetId: petMap['Miso']?.id,
      reason: 'inaccurate_information',
      details: 'The age listed appears to be incorrect based on the photo.',
    },
    {
      reporterId: userIds['jamie'], targetId: petMap['Scout']?.id,
      reason: 'duplicate_listing',
      details: 'This listing may duplicate another rescue listing; please review the source record.',
    },
  ];
  for (const report of reports) {
    if (!report.reporterId || !report.targetId) continue;
    await q(client, `
      INSERT INTO reports (reporter_id, target_type, target_id, reason, details, status)
      SELECT $1,'pet',$2,$3,$4,'open'
      WHERE NOT EXISTS (
        SELECT 1 FROM reports
        WHERE reporter_id=$1 AND target_type='pet' AND target_id=$2
          AND reason=$3 AND details=$4 AND status='open'
      )
      ON CONFLICT DO NOTHING
    `, [report.reporterId, report.targetId, report.reason, report.details]);
  }
}

// ─────────────────────────────────────────────
// UPDATE PET STATUSES (adopted / pending)
// ─────────────────────────────────────────────
async function updatePetStatuses(client, petMap) {
  // completed applications → adopted
  for (const name of ['Biscuit', 'Bruno']) {
    if (petMap[name]) {
      await q(client, `UPDATE pets SET status='adopted' WHERE id=$1`, [petMap[name].id]);
    }
  }
  // approved applications → pending
  for (const name of ['Miso', 'Rocky']) {
    if (petMap[name]) {
      await q(client, `UPDATE pets SET status='pending' WHERE id=$1`, [petMap[name].id]);
    }
  }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  if (env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    throw new Error('Refusing to seed a production database. Pass --force only for an intentional, reviewed seed operation.');
  }
  if (env.SEED_PASSWORD === 'PawPal@2026') {
    console.warn('[seed] WARNING: the default demo password is configured. Change SEED_PASSWORD before using these accounts.');
  }
  const client = await pool.connect();
  try {
    const password = env.SEED_PASSWORD;
    console.log('\n🌱  PawPal seed starting...\n');

    // 1. Users
    process.stdout.write('  → Users...');
    const userIds = await seedUsers(client, password);
    console.log(` ✓ (${Object.keys(userIds).length})`);

    // 2. Shelters
    process.stdout.write('  → Shelters...');
    const shelterIds = await seedShelters(client, userIds, userIds['admin']);
    console.log(` ✓ (${Object.keys(shelterIds).length})`);

    // 3. Pets
    process.stdout.write('  → Pets...');
    const petDefs = buildPets(shelterIds);
    const petMap = {}; // name → { id, shelter_id }
    const bondGroups = {}; // bondKey → [{ id, key }]

    for (const p of petDefs) {
      const id = await insertPet(client, p);
      if (id) {
        petMap[p.name] = { id, shelter_id: p.shelter_id };
        if (p.img) await insertPhoto(client, id, p.img, 0);
        // Track bonded pairs
        if (p._bondKey) {
          if (!bondGroups[p._bondKey]) bondGroups[p._bondKey] = [];
          bondGroups[p._bondKey].push(id);
        }
      }
    }

    // Set bonded_pet_id for pairs
    for (const [, ids] of Object.entries(bondGroups)) {
      if (ids.length === 2) {
        await q(client, `UPDATE pets SET bonded_pet_id=$1 WHERE id=$2`, [ids[1], ids[0]]);
        await q(client, `UPDATE pets SET bonded_pet_id=$1 WHERE id=$2`, [ids[0], ids[1]]);
      }
    }
    console.log(` ✓ (${Object.keys(petMap).length})`);

    // 4. Vaccines
    process.stdout.write('  → Vaccines...');
    const vaccineTypes = await getVaccineTypes(client);
    const petRows = Object.entries(petMap).map(([name, { id }]) => {
      const def = petDefs.find(p => p.name === name);
      return { id, species: def?.species, age_months: def?.age_months, name };
    });
    await seedVaccines(client, petRows, vaccineTypes);
    console.log(' ✓');

    // 5. Applications
    process.stdout.write('  → Applications...');
    await seedApplications(client, userIds, petMap);
    console.log(' ✓ (10)');

    // 6. Update pet statuses
    await updatePetStatuses(client, petMap);

    // 7. Reports
    process.stdout.write('  → Reports...');
    await seedReports(client, userIds, petMap);
    console.log(' ✓ (2 open)');

    // ─── Count verification ───
    const { rows: counts } = await q(client, `
      SELECT 'users' t, count(*)::int c FROM users
      UNION ALL SELECT 'shelters', count(*)::int FROM shelters
      UNION ALL SELECT 'pets',     count(*)::int FROM pets
      UNION ALL SELECT 'applications', count(*)::int FROM applications
      UNION ALL SELECT 'pet_photos',   count(*)::int FROM pet_photos
      UNION ALL SELECT 'reports',      count(*)::int FROM reports
    `);

    console.log('\n─────────────────────────────');
    console.log('  Seed counts:');
    for (const r of counts) {
      console.log(`    ${r.t.padEnd(15)} ${r.c}`);
    }

    // ─── Species breakdown ───
    const { rows: species } = await q(client,
      `SELECT species, status, count(*)::int n FROM pets GROUP BY 1,2 ORDER BY 1,2`);
    console.log('\n  Pets by species/status:');
    for (const r of species) {
      console.log(`    ${r.species.padEnd(8)} ${r.status.padEnd(12)} ${r.n}`);
    }

    // ─── Demo logins ───
    console.log('\n─────────────────────────────');
    console.log('  Demo login accounts (password configured separately)');
    console.log('─────────────────────────────');
    const logins = [
      { role: 'Admin',   email: 'admin@pawpal.test',    note: 'Full platform control' },
      { role: 'Shelter', email: 'sarah@rosecity.test',  note: 'Rose City (Portland, OR) — VERIFIED' },
      { role: 'Shelter', email: 'miguel@lonestar.test', note: 'Lone Star Rescue (Austin, TX) — VERIFIED' },
      { role: 'Shelter', email: 'priya@emerald.test',   note: 'Emerald City Paws (Seattle, WA) — VERIFIED' },
      { role: 'Shelter', email: 'jordan@milehigh.test', note: 'Mile High Rescue (Denver, CO) — PENDING' },
      { role: 'Adopter', email: 'alex@pawpal.test',     note: 'Alex Rivera — has 3 applications' },
      { role: 'Adopter', email: 'jamie@pawpal.test',    note: 'Jamie Brooks' },
      { role: 'Adopter', email: 'casey@pawpal.test',    note: 'Casey Morgan' },
      { role: 'Adopter', email: 'drew@pawpal.test',     note: 'Drew Sullivan' },
    ];
    console.log('  Role'.padEnd(12), 'Email'.padEnd(32), 'Note');
    console.log('  ' + '─'.repeat(70));
    for (const l of logins) {
      console.log(`  ${l.role.padEnd(10)} ${l.email.padEnd(32)} ${l.note}`);
    }
    console.log('─────────────────────────────\n');
    console.log('✅  Seed complete.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[seed] Fatal:', err.message);
    process.exitCode = 1;
  });
}

