import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { app } from '../app.js';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { createPetWorld, newFixtureIdentity } from './helpers/petFixtures.js';

const ids = { users:[], shelters:[], pets:[], documents:[], reports:[] };
let adminCookie, adminId, adopter, targetUser, shelterWorld, documentId;

function cookieFor(id) {
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({sub:id,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  const unsigned=`${header}.${payload}`,signature=createHmac('sha256',env.JWT_SECRET).update(unsigned).digest('base64url');
  return `pawpal_token=${unsigned}.${signature}`;
}

async function register(role='adopter') {
  const agent=request.agent(app),result=await agent.post('/api/auth/register').send({...newFixtureIdentity(),role});
  expect(result.status).toBe(201);ids.users.push(result.body.user.id);return {agent,id:result.body.user.id};
}

beforeAll(async()=>{
  const {rows}=await pool.query('SELECT current_database() AS name');
  if(rows[0]?.name!=='pawpal_test')throw new Error('Admin integration tests require pawpal_test; no fixture writes were made.');
  const suffix=randomUUID().replaceAll('-','').slice(0,20);
  const admin=await pool.query("INSERT INTO users (user_code,name,email,password_hash,role,status) VALUES ($1,$2,$3,'test-hash','admin','active') RETURNING id",[`admin_${suffix}`,`Fixture Admin ${suffix}`,`admin_${suffix}@pawpal.test`]);
  adminId=admin.rows[0].id;ids.users.push(adminId);adminCookie=cookieFor(adminId);
  adopter=await register();targetUser=await register();
  shelterWorld=await createPetWorld(pool);
  ids.shelters.push(shelterWorld.shelterId);
  const pet=await shelterWorld.pet({name:`Reported pet ${suffix}`});ids.pets.push(pet);
  const document=await pool.query("INSERT INTO shelter_documents (shelter_id,file_name,mime_type,byte_size,data) VALUES ($1,'fixture.pdf','application/pdf',14,$2) RETURNING id",[shelterWorld.shelterId,Buffer.from('%PDF-1.7\n%%EOF')]);
  documentId=document.rows[0].id;ids.documents.push(documentId);
});

afterAll(async()=>{
  if(ids.reports.length)await pool.query('DELETE FROM reports WHERE id=ANY($1::uuid[])',[ids.reports]);
  if(ids.users.length)await pool.query('DELETE FROM audit_log WHERE actor_id=ANY($1::uuid[])',[ids.users]);
  if(ids.pets.length)await pool.query('DELETE FROM pets WHERE id=ANY($1::uuid[])',[ids.pets]);
  if(ids.documents.length)await pool.query('DELETE FROM shelter_documents WHERE id=ANY($1::uuid[])',[ids.documents]);
  if(shelterWorld)await shelterWorld.cleanup();
  for(const id of ids.shelters)await pool.query('DELETE FROM shelters WHERE id=$1',[id]);
  for(const id of ids.users)await pool.query('DELETE FROM users WHERE id=$1',[id]);
  await pool.end();
});

async function report(targetType,targetId){
  const result=await adopter.agent.post('/api/reports').send({targetType,targetId,reason:'inaccurate_information',details:'Fixture report details.'});
  expect(result.status).toBe(201);ids.reports.push(result.body.report.id);return result.body.report;
}

describe('admin control and report APIs (pawpal_test fixtures)',()=>{
  it('requires an administrator and provides statistics and paginated user rows',async()=>{
    expect((await request(app).get('/api/admin/stats')).status).toBe(401);
    expect((await adopter.agent.get('/api/admin/stats')).status).toBe(403);
    const stats=await request(app).get('/api/admin/stats').set('Cookie',adminCookie);
    expect(stats.status).toBe(200);expect(stats.body).toHaveProperty('users_total');
    const users=await request(app).get('/api/admin/users?q=Fixture&page=1&pageSize=2').set('Cookie',adminCookie);
    expect(users.status).toBe(200);expect(users.body.items.length).toBeLessThanOrEqual(2);expect(users.body.total).toBeGreaterThanOrEqual(2);
  });

  it('serves shelter documents only to admins with safe inline headers and audits verification',async()=>{
    expect((await adopter.agent.get(`/api/admin/documents/${documentId}`)).status).toBe(403);
    const file=await request(app).get(`/api/admin/documents/${documentId}`).set('Cookie',adminCookie);
    expect(file.status).toBe(200);expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toContain('inline');expect(file.headers['x-content-type-options']).toBe('nosniff');
    const result=await request(app).patch(`/api/admin/shelters/${shelterWorld.shelterId}/verification`).set('Cookie',adminCookie).send({action:'verify'});
    expect(result.status).toBe(200);expect(result.body.shelter.verification_status).toBe('verified');
    const logs=await pool.query("SELECT count(*)::int n FROM audit_log WHERE actor_id=$1 AND action='shelter.verify' AND target_id=$2",[adminId,shelterWorld.shelterId]);expect(logs.rows[0].n).toBe(1);
    const rejection=await request(app).patch(`/api/admin/shelters/${shelterWorld.shelterId}/verification`).set('Cookie',adminCookie).send({action:'reject'});
    expect(rejection.status).toBe(400);
    const rejected=await request(app).patch(`/api/admin/shelters/${shelterWorld.shelterId}/verification`).set('Cookie',adminCookie).send({action:'reject',reason:'Fixture verification document did not match.'});
    expect(rejected.status).toBe(200);expect(rejected.body.shelter.verification_note).toBe('Fixture verification document did not match.');
  });

  it('prevents self-actions and blocks suspension of the last active administrator',async()=>{
    const suffix=randomUUID().replaceAll('-','').slice(0,20);
    const second=await pool.query("INSERT INTO users (user_code,name,email,password_hash,role,status) VALUES ($1,$2,$3,'test-hash','admin','active') RETURNING id",[`admin_${suffix}`,`Fixture Admin ${suffix}`,`admin_${suffix}@pawpal.test`]);
    const secondId=second.rows[0].id;ids.users.push(secondId);const secondCookie=cookieFor(secondId);
    expect((await request(app).patch(`/api/admin/users/${adminId}/status`).set('Cookie',adminCookie).send({status:'suspend'})).status).toBe(422);
    const suspended=await request(app).patch(`/api/admin/users/${secondId}/status`).set('Cookie',adminCookie).send({status:'suspend'});
    expect(suspended.status).toBe(200);
    const blocked=await request(app).patch(`/api/admin/users/${adminId}/status`).set('Cookie',adminCookie).send({status:'suspend'});
    expect(blocked.status).toBe(409);expect(blocked.body.error.code).toBe('LAST_ACTIVE_ADMIN');
    const active=await pool.query("SELECT id FROM users WHERE role='admin' AND status='active'");expect(active.rowCount).toBe(1);
    const activeId=active.rows[0].id,activeCookie=activeId===adminId?adminCookie:secondCookie;
    expect((await request(app).patch(`/api/admin/users/${activeId}/status`).set('Cookie',activeCookie).send({status:'suspend'})).status).toBe(409);
    expect((await request(app).delete(`/api/admin/users/${activeId}`).set('Cookie',activeCookie)).status).toBe(422);
    const changed=await request(app).patch(`/api/admin/users/${targetUser.id}/status`).set('Cookie',activeCookie).send({status:'suspend'});
    expect(changed.status).toBe(200);expect(changed.body.user.status).toBe('suspended');
    const activated=await request(app).patch(`/api/admin/users/${targetUser.id}/status`).set('Cookie',activeCookie).send({status:'activate'});
    expect(activated.status).toBe(200);expect(activated.body.user.status).toBe('active');
    const logs=await pool.query("SELECT count(*)::int n FROM audit_log WHERE action IN ('user.suspend','user.activate') AND target_id=$1",[targetUser.id]);expect(logs.rows[0].n).toBe(2);
  });

  it('creates reports, prevents duplicates, and dismisses them with an audit entry',async()=>{
    const created=await report('pet',ids.pets[0]);
    const queue=await request(app).get('/api/admin/reports').set('Cookie',adminCookie);expect(queue.status).toBe(200);expect(queue.body.items.some(item=>item.id===created.id)).toBe(true);
    expect((await adopter.agent.get('/api/admin/reports')).status).toBe(403);
    const duplicate=await adopter.agent.post('/api/reports').send({targetType:'pet',targetId:ids.pets[0],reason:'other',details:''});
    expect(duplicate.status).toBe(409);expect(duplicate.body.error.code).toBe('DUPLICATE_REPORT');
    const closed=await request(app).patch(`/api/admin/reports/${created.id}`).set('Cookie',adminCookie).send({action:'dismiss',note:'Reviewed fixture report.'});
    expect(closed.status).toBe(200);expect(closed.body.report.status).toBe('dismissed');
    const logs=await pool.query("SELECT count(*)::int n FROM audit_log WHERE actor_id=$1 AND action='report.dismiss' AND target_id=$2",[adminId,ids.pets[0]]);expect(logs.rows[0].n).toBe(1);
  });

  it('removes a reported listing atomically and audits the moderation reason',async()=>{
    const created=await report('pet',ids.pets[0]);
    const resolved=await request(app).patch(`/api/admin/reports/${created.id}`).set('Cookie',adminCookie).send({action:'remove_listing',note:'Fixture listing violates policy.'});
    expect(resolved.status).toBe(200);expect(resolved.body.report.status).toBe('resolved');
    const pet=await pool.query('SELECT status,removed_at FROM pets WHERE id=$1',[ids.pets[0]]);expect(pet.rows[0].status).toBe('removed');expect(pet.rows[0].removed_at).not.toBeNull();
    const log=await pool.query("SELECT details FROM audit_log WHERE actor_id=$1 AND action='report.remove_listing' AND target_id=$2 ORDER BY id DESC LIMIT 1",[adminId,ids.pets[0]]);expect(log.rows[0].details.reason).toBe('Fixture listing violates policy.');
  });

  it('suspends a reported user transactionally and exposes a limited audit feed',async()=>{
    const created=await report('user',targetUser.id);
    const resolved=await request(app).patch(`/api/admin/reports/${created.id}`).set('Cookie',adminCookie).send({action:'suspend_user',note:'Fixture account requires review.'});
    expect(resolved.status).toBe(200);expect((await pool.query('SELECT status FROM users WHERE id=$1',[targetUser.id])).rows[0].status).toBe('suspended');
    const audit=await request(app).get('/api/admin/audit').set('Cookie',adminCookie);expect(audit.status).toBe(200);expect(audit.body.items.length).toBeLessThanOrEqual(50);expect(audit.body.items.some(item=>item.action==='report.suspend_user')).toBe(true);
  });

  it('returns admin listings and applications as read-only resources',async()=>{
    expect((await request(app).get('/api/admin/pets').set('Cookie',adminCookie)).status).toBe(200);
    expect((await request(app).get('/api/admin/applications').set('Cookie',adminCookie)).status).toBe(200);
  });

  it('hides a shelter owner’s listings from public browse immediately after suspension',async()=>{
    const livePet=await shelterWorld.pet({name:`Live public pet ${randomUUID().slice(0,8)}`});ids.pets.push(livePet);
    const suspended=await request(app).patch(`/api/admin/users/${shelterWorld.userId}/status`).set('Cookie',adminCookie).send({status:'suspend'});
    expect(suspended.status).toBe(200);
    const browse=await request(app).get(`/api/pets?q=${encodeURIComponent('Live public pet')}`);
    expect(browse.status).toBe(200);expect(browse.body.items.some(pet=>pet.id===livePet)).toBe(false);
  });

  it('soft-removes users and listings, requires a listing reason, and audits both actions',async()=>{
    const removedUser=await register();
    const userRemoval=await request(app).delete(`/api/admin/users/${removedUser.id}`).set('Cookie',adminCookie);
    expect(userRemoval.status).toBe(200);expect((await pool.query('SELECT status FROM users WHERE id=$1',[removedUser.id])).rows[0].status).toBe('removed');
    expect((await request(app).delete(`/api/admin/pets/${ids.pets[0]}`).set('Cookie',adminCookie).send({})).status).toBe(400);
    const listing=await request(app).delete(`/api/admin/pets/${ids.pets[0]}`).set('Cookie',adminCookie).send({reason:'Fixture moderation reason.'});
    expect(listing.status).toBe(200);expect((await pool.query('SELECT status FROM pets WHERE id=$1',[ids.pets[0]])).rows[0].status).toBe('removed');
    const logs=await pool.query("SELECT action,target_id FROM audit_log WHERE actor_id=$1 AND target_id IN ($2,$3)",[adminId,removedUser.id,ids.pets[0]]);
    expect(logs.rows.map(row=>row.action)).toContain('user.remove');expect(logs.rows.map(row=>row.action)).toContain('listing.remove');
  });
});
