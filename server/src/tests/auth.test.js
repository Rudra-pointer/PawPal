import {afterAll,describe,it,expect} from 'vitest';
import 'dotenv/config';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {app} from '../app.js';
import {pool} from '../db/pool.js';

const stamp=randomUUID().slice(0,8),userCode=`qa_${stamp}`,email=`qa_${stamp}@pawpal.test`,password='PawPalTest123';
const payload={name:'QA Adopter',email,userCode,password,role:'adopter'};
let agent,userId;
const fixtureIds=[];
afterAll(async()=>{for(const id of fixtureIds)await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.end()});

describe('Prompt 2 auth endpoints (pawpal_test)',()=>{
 it('registers an adopter and sets a secure session cookie',async()=>{agent=request.agent(app);const r=await agent.post('/api/auth/register').send(payload);expect(r.status).toBe(201);expect(r.body.user.role).toBe('adopter');expect(r.headers['set-cookie'][0]).toMatch(/HttpOnly/i);expect(r.headers['set-cookie'][0]).toMatch(/SameSite=Lax/i);expect(r.headers['set-cookie'][0]).toMatch(/Path=\//i);userId=r.body.user.id;fixtureIds.push(userId)});
 it('registers a shelter-role user for shelter profile setup',async()=>{const r=await request.agent(app).post('/api/auth/register').send({...payload,email:`shelter_${email}`,userCode:`shelter_${userCode}`,role:'shelter'});expect(r.status).toBe(201);expect(r.body.user.role).toBe('shelter');fixtureIds.push(r.body.user.id)});
 it('rejects duplicate email',async()=>{const r=await request(app).post('/api/auth/register').send({...payload,userCode:`${userCode}2`});expect(r.status).toBe(409)});
 it('rejects duplicate user id',async()=>{const r=await request(app).post('/api/auth/register').send({...payload,email:`other_${email}`});expect(r.status).toBe(409)});
 it('rejects weak passwords',async()=>{const r=await request(app).post('/api/auth/register').send({...payload,email:`weak_${email}`,userCode:`weak_${userCode}`,password:'short'});expect(r.status).toBe(400)});
 it('rejects invalid email and malformed registration',async()=>{const r=await request(app).post('/api/auth/register').send({...payload,email:'bad'});expect(r.status).toBe(400)});
 it('does not allow admin registration',async()=>{const r=await request(app).post('/api/auth/register').send({...payload,email:`admin_${email}`,userCode:`admin_${userCode}`,role:'admin'});expect(r.status).toBe(400)});
 it('logs in by email',async()=>{const r=await request.agent(app).post('/api/auth/login').send({identifier:email,password});expect(r.status).toBe(200);expect(r.body.user.id).toBe(userId)});
 it('logs in by case-insensitive email',async()=>{const r=await request.agent(app).post('/api/auth/login').send({identifier:email.toUpperCase(),password});expect(r.status).toBe(200);expect(r.body.user.id).toBe(userId)});
 it('logs in by case-insensitive user id',async()=>{const r=await request(app).post('/api/auth/login').send({identifier:userCode.toUpperCase(),password});expect(r.status).toBe(200)});
 it('rejects incorrect password generically',async()=>{const r=await request(app).post('/api/auth/login').send({identifier:email,password:'incorrect'});expect(r.status).toBe(401);expect(r.body.error.message).toBe('Invalid credentials')});
 it('rejects a nonexistent account generically',async()=>{const r=await request(app).post('/api/auth/login').send({identifier:`missing_${email}`,password});expect(r.status).toBe(401);expect(r.body.error.message).toBe('Invalid credentials')});
 it('returns the authenticated current user',async()=>{const r=await agent.get('/api/auth/me');expect(r.status).toBe(200);expect(r.body.user.id).toBe(userId)});
 it('rejects an unauthenticated current-user request',async()=>{const r=await request(app).get('/api/auth/me');expect(r.status).toBe(401)});
 it('blocks protected admin route without authentication',async()=>{const r=await request(app).get('/api/admin/ping');expect(r.status).toBe(401)});
 it('denies adopter access to admin route',async()=>{const r=await agent.get('/api/admin/ping');expect(r.status).toBe(403)});
 it('rejects empty availability queries',async()=>{const r=await request(app).get('/api/auth/availability');expect(r.status).toBe(400)});
 it('rejects invalid user IDs without querying user data',async()=>{const r=await request(app).get('/api/auth/availability?userCode=bad%20id');expect(r.status).toBe(400)});
 it('reports a new user ID as available',async()=>{const r=await request(app).get('/api/auth/availability?userCode=unused_'+stamp);expect(r.status).toBe(200);expect(r.body).toEqual({available:true})});
 it('reports an existing user ID as unavailable without disclosing user data',async()=>{const r=await request(app).get('/api/auth/availability?userCode='+userCode);expect(r.status).toBe(200);expect(r.body).toEqual({available:false})});
 it('blocks suspended and removed accounts on authenticated requests and login',async()=>{const suspended=request.agent(app),r=await suspended.post('/api/auth/register').send({...payload,email:`suspended_${email}`,userCode:`suspended_${userCode}`});expect(r.status).toBe(201);fixtureIds.push(r.body.user.id);await pool.query("UPDATE users SET status='suspended' WHERE id=$1",[r.body.user.id]);const current=await suspended.get('/api/auth/me');expect(current.status).toBe(403);expect(current.body.error.code).toBe('ACCOUNT_SUSPENDED');await pool.query("UPDATE users SET status='removed' WHERE id=$1",[r.body.user.id]);const removed=await suspended.get('/api/auth/me');expect(removed.status).toBe(403);expect(removed.body.error.code).toBe('ACCOUNT_SUSPENDED');const login=await request(app).post('/api/auth/login').send({identifier:`suspended_${email}`,password});expect(login.status).toBe(403);expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED')});
 it('limits login to ten attempts per IP and identifier in the window',async()=>{const identifier=`throttle_${stamp}@pawpal.test`;for(let i=0;i<10;i++){const r=await request(app).post('/api/auth/login').send({identifier,password:'WrongPassword123'});expect(r.status).toBe(401)}const limited=await request(app).post('/api/auth/login').send({identifier,password:'WrongPassword123'});expect(limited.status).toBe(429);expect(limited.body.error.code).toBe('RATE_LIMITED')});
 it('logs out and clears the cookie',async()=>{const r=await agent.post('/api/auth/logout');expect(r.status).toBe(200);expect(r.headers['set-cookie'][0]).toMatch(/pawpal_token=;/);expect((await agent.get('/api/auth/me')).status).toBe(401)});
});
