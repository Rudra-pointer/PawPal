import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const userIds = [];
const shelterIds = [];
const petIds = [];
const applicationIds = [];
let owner;
let otherOwner;
let pendingOwner;

async function createOwner(verificationStatus = 'verified') {
  const agent = request.agent(app);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
  const registration = await agent.post('/api/auth/register').send({
    name: `Shelter ${suffix}`, email: `shelter_${suffix}@pawpal.test`, userCode: `shelter_${suffix}`,
    password: 'PawPalTest123', role: 'shelter',
  });
  expect(registration.status).toBe(201);
  const userId = registration.body.user.id;
  userIds.push(userId);
  const shelter = await pool.query(`
    INSERT INTO shelters (owner_user_id,name,address_line,city,state,contact_email,verification_status)
    VALUES ($1,$2,'1 Test Way','Portland','OR',$3,$4) RETURNING id
  `, [userId, `Test shelter ${suffix}`, `contact_${suffix}@pawpal.test`, verificationStatus]);
  shelterIds.push(shelter.rows[0].id);
  return { agent, userId, shelterId: shelter.rows[0].id };
}

const petPayload = (name = 'Test Companion') => ({
  name, species: 'dog', breed: 'Mixed breed', ageMonths: 24, gender: 'unknown', size: 'medium',
  description: 'A fixture pet created by a focused integration test.', temperament: ['gentle'], energyLevel: 'medium',
  spayedNeutered: true, microchipped: false, houseTrained: true, specialNeeds: false,
  goodWithChildren: 'unknown', goodWithDogs: 'yes', goodWithCats: 'unknown',
});

async function createPet(agent, name) {
  const response = await agent.post('/api/shelter/pets').send(petPayload(name));
  expect(response.status).toBe(201);
  petIds.push(response.body.pet.id);
  return response.body.pet;
}

beforeAll(async () => {
  const { rows } = await pool.query('SELECT current_database() AS name');
  if (rows[0]?.name !== 'pawpal_test') throw new Error('Shelter pet tests require pawpal_test; no fixture writes were made.');
  owner = await createOwner();
  otherOwner = await createOwner();
  pendingOwner = await createOwner('pending');
});

afterAll(async () => {
  if (applicationIds.length) await pool.query('DELETE FROM applications WHERE id=ANY($1::uuid[])', [applicationIds]);
  if (petIds.length) await pool.query('DELETE FROM pets WHERE id=ANY($1::uuid[])', [petIds]);
  for (const id of shelterIds) await pool.query('DELETE FROM shelters WHERE id=$1', [id]);
  for (const id of userIds) await pool.query('DELETE FROM users WHERE id=$1', [id]);
  await pool.end();
});

describe('shelter pet management (pawpal_test fixtures)', () => {
  it('creates, lists, edits and soft-removes only the owner shelter pet', async () => {
    const pet = await createPet(owner.agent, 'Juniper');
    expect(pet).toMatchObject({ name: 'Juniper', status: 'available', shelterId: owner.shelterId });
    const list = await owner.agent.get('/api/shelter/pets?status=available&page=1&pageSize=10');
    expect(list.status).toBe(200);
    expect(list.body.items.some(item => item.id === pet.id)).toBe(true);
    const dashboard=await owner.agent.get('/api/shelter/dashboard');
    expect(dashboard.status).toBe(200);expect(dashboard.body.verificationStatus).toBe('verified');
    expect(Number(dashboard.body.stats.total_pets)).toBeGreaterThanOrEqual(1);
    const update = await owner.agent.put(`/api/shelter/pets/${pet.id}`).send({ name: 'Juniper Updated' });
    expect(update.status).toBe(200);
    expect(update.body.pet.name).toBe('Juniper Updated');
    const removed = await owner.agent.delete(`/api/shelter/pets/${pet.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.pet.status).toBe('removed');
    expect((await pool.query('SELECT status,removed_at FROM pets WHERE id=$1', [pet.id])).rows[0].removed_at).not.toBeNull();
  });

  it('blocks unverified publishing and rejects pets younger than eight weeks', async () => {
    const blocked = await pendingOwner.agent.post('/api/shelter/pets').send(petPayload());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SHELTER_NOT_VERIFIED');
    const tooYoung = await owner.agent.post('/api/shelter/pets').send({ ...petPayload(), ageMonths: 1 });
    expect(tooYoung.status).toBe(400);
    expect(tooYoung.body.error.details.some(issue => issue.message.includes('at least 8 weeks'))).toBe(true);
  });

  it('publishes normalized custom species, exposes them in public filters, and uses only generic vaccines', async () => {
    const hamsterResponse = await owner.agent.post('/api/shelter/pets').send({ ...petPayload('Nibbles'), species: '  HAMSTER  ' });
    expect(hamsterResponse.status).toBe(201);
    expect(hamsterResponse.body.pet.species).toBe('hamster');
    const hamsterId = hamsterResponse.body.pet.id;
    petIds.push(hamsterId);

    const birdResponse = await owner.agent.post('/api/shelter/pets').send({ ...petPayload('Pip'), species: '  Parrot  ' });
    expect(birdResponse.status).toBe(201);
    expect(birdResponse.body.pet.species).toBe('parrot');
    const birdId = birdResponse.body.pet.id;
    petIds.push(birdId);

    const metadata = await request(app).get('/api/meta/filters');
    expect(metadata.body.species).toEqual(expect.arrayContaining([
      expect.objectContaining({ species: 'hamster', count: 1 }),
      expect.objectContaining({ species: 'parrot', count: 1 }),
    ]));
    const hamsterBrowse = await request(app).get('/api/pets?species=HAMSTER');
    expect(hamsterBrowse.status).toBe(200);
    expect(hamsterBrowse.body.items.map(item => item.id)).toContain(hamsterId);
    expect(hamsterBrowse.body.items.every(item => item.species === 'hamster')).toBe(true);

    const profile = await request(app).get(`/api/pets/${hamsterId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.species).toBe('hamster');
    expect(profile.body.vaccinations.some(item => ['RABIES', 'DHPP', 'FVRCP', 'FELV'].includes(item.code))).toBe(false);
    expect(profile.body.vaccinations).toContainEqual(expect.objectContaining({ code: 'OTHER', isGeneric: true }));
    const vaccineList = await owner.agent.get(`/api/shelter/pets/${hamsterId}/vaccinations`);
    expect(vaccineList.body.vaccineTypes).toContainEqual(expect.objectContaining({ code: 'OTHER', is_generic: true }));

    expect((await owner.agent.delete(`/api/shelter/pets/${hamsterId}`)).status).toBe(200);
    expect((await owner.agent.delete(`/api/shelter/pets/${birdId}`)).status).toBe(200);
    const afterRemoval = await request(app).get('/api/meta/filters');
    expect(afterRemoval.body.species.some(item => ['hamster', 'parrot'].includes(item.species))).toBe(false);
  });

  it('enforces ownership and requires authentication', async () => {
    const pet = await createPet(owner.agent, 'Owned pet');
    expect((await otherOwner.agent.get(`/api/shelter/pets/${pet.id}`)).status).toBe(404);
    expect((await otherOwner.agent.put(`/api/shelter/pets/${pet.id}`).send({ name: 'Stolen edit' })).status).toBe(404);
    expect((await request(app).get('/api/shelter/pets')).status).toBe(401);
  });

  it('validates pet photos and stores only processed JPEG bytes', async () => {
    const pet = await createPet(owner.agent, 'Photo pet');
    const png = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#aabbcc' } }).png().toBuffer();
    const tagged = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#aabbcc' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'fixture marker' } } }).toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeTruthy();
    const uploaded = await owner.agent.post(`/api/shelter/pets/${pet.id}/photos`).attach('photos', tagged, { filename: 'portrait.jpg', contentType: 'image/jpeg' });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.photos[0]).toMatchObject({ mime_type: 'image/jpeg', is_primary: true });
    const stored = await pool.query('SELECT mime_type,byte_size,data FROM pet_photos WHERE id=$1', [uploaded.body.photos[0].id]);
    expect(stored.rows[0].mime_type).toBe('image/jpeg');
    expect(stored.rows[0].data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(stored.rows[0].byte_size).toBe(stored.rows[0].data.length);
    expect((await sharp(stored.rows[0].data).metadata()).exif).toBeUndefined();
    const fake = await owner.agent.post(`/api/shelter/pets/${pet.id}/photos`).attach('photos', Buffer.from('not an image'), { filename: 'fake.jpg', contentType: 'image/jpeg' });
    expect(fake.status).toBe(400);
    const forbidden = await otherOwner.agent.delete(`/api/shelter/pets/${pet.id}/photos/${uploaded.body.photos[0].id}`);
    expect(forbidden.status).toBe(404);
  });

  it('enforces photo limits and supports primary, ordering and scoped deletion', async () => {
    const pet = await createPet(owner.agent, 'Photo limits');
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ddeeff' } }).png().toBuffer();
    const upload = owner.agent.post(`/api/shelter/pets/${pet.id}/photos`);
    for (let index=0; index<6; index++) upload.attach('photos',png,{filename:`photo-${index}.png`,contentType:'image/png'});
    const six=await upload;expect(six.status).toBe(201);expect(six.body.photos).toHaveLength(6);
    const extra=await owner.agent.post(`/api/shelter/pets/${pet.id}/photos`).attach('photos',png,{filename:'extra.png',contentType:'image/png'});
    expect(extra.status).toBe(413);
    const oversize=await owner.agent.post(`/api/shelter/pets/${pet.id}/photos`).attach('photos',Buffer.alloc(5*1024*1024+1),{filename:'huge.jpg',contentType:'image/jpeg'});
    expect(oversize.status).toBe(413);
    const ids=six.body.photos.map(photo=>photo.id);
    expect((await owner.agent.put(`/api/shelter/pets/${pet.id}/photos/order`).send({photoIds:[...ids].reverse()})).status).toBe(200);
    expect((await owner.agent.patch(`/api/shelter/pets/${pet.id}/photos/${ids[1]}/primary`)).status).toBe(200);
    expect((await otherOwner.agent.put(`/api/shelter/pets/${pet.id}/photos/order`).send({photoIds:ids})).status).toBe(404);
    expect((await owner.agent.delete(`/api/shelter/pets/${pet.id}/photos/${ids[1]}`)).status).toBe(200);
    const remaining=await pool.query('SELECT count(*)::int count,bool_or(is_primary) primary FROM pet_photos WHERE pet_id=$1',[pet.id]);
    expect(remaining.rows[0]).toMatchObject({count:5,primary:true});
  });

  it('lists species vaccines and rejects a vaccine for another species and invalid dates', async () => {
    const pet = await createPet(owner.agent, 'Vaccine pet');
    const list = await owner.agent.get(`/api/shelter/pets/${pet.id}/vaccinations`);
    expect(list.status).toBe(200);
    expect(list.body.vaccineTypes.length).toBeGreaterThan(0);
    expect(list.body.vaccineTypes.every(type => type.species === 'dog' || type.is_generic)).toBe(true);
    const catVaccine = await pool.query("SELECT id FROM vaccine_types WHERE species='cat' LIMIT 1");
    const mismatch = await owner.agent.post(`/api/shelter/pets/${pet.id}/vaccinations`).send({ vaccineTypeId: catVaccine.rows[0].id, givenOn: '2026-01-01' });
    expect(mismatch.status).toBe(422);
    const impossible = await owner.agent.post(`/api/shelter/pets/${pet.id}/vaccinations`).send({ vaccineTypeId: list.body.vaccineTypes[0].id, givenOn: '2026-99-99' });
    expect(impossible.status).toBe(400);
    expect((await otherOwner.agent.get(`/api/shelter/pets/${pet.id}/vaccinations`)).status).toBe(404);
    const future=await owner.agent.post(`/api/shelter/pets/${pet.id}/vaccinations`).send({vaccineTypeId:list.body.vaccineTypes[0].id,givenOn:'2099-01-01'});
    expect(future.status).toBe(422);expect(future.body.error.code).toBe('FUTURE_VACCINATION_DATE');
  });

  it('exports formula-safe CSV and refuses soft removal while an application is approved', async()=>{
    const formulaPet=await createPet(owner.agent,'=1+1');
    const csv=await owner.agent.get('/api/shelter/pets/export.csv');expect(csv.status).toBe(200);expect(csv.text).toContain("'=1+1");
    const approvedPet=await createPet(owner.agent,'Approved application pet');
    const application=await pool.query(`INSERT INTO applications (pet_id,adopter_id,applicant_name,applicant_email,contact_no,address_line,city,home_type,ownership,experience,reason,status)
      VALUES ($1,$2,'Fixture Applicant','fixture-applicant@pawpal.test','555-0100','1 Fixture Way','Portland','house_with_yard','own','some','A fixture application created to verify protected pet deletion.','approved') RETURNING id`,[approvedPet.id,owner.userId]);
    applicationIds.push(application.rows[0].id);
    const refused=await owner.agent.delete(`/api/shelter/pets/${approvedPet.id}`);expect(refused.status).toBe(409);expect(refused.body.error.code).toBe('PET_HAS_APPROVED_APPLICATION');
  });
});
