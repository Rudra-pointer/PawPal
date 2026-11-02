import {describe,it,expect} from 'vitest';
import {SEED_USERS,SEED_SHELTERS,SEED_APPLICATIONS} from '../db/seedData.js';
import {buildPets} from '../db/seed.js';

const pets=buildPets({rose_owner:'rose',lonestar_owner:'lone',emerald_owner:'emerald',milehigh_owner:'mile'});

describe('Demo seed dataset (pure; no database writes)',()=>{
 it('defines 9 unique users, including admin, 4 shelter owners and 4 adopters',()=>{expect(SEED_USERS).toHaveLength(9);expect(new Set(SEED_USERS.map(u=>u.user_code)).size).toBe(9);expect(SEED_USERS.filter(u=>u.role==='admin')).toHaveLength(1);expect(SEED_USERS.filter(u=>u.role==='shelter')).toHaveLength(4);expect(SEED_USERS.filter(u=>u.role==='adopter')).toHaveLength(4)});
 it('defines four shelters, three verified and one pending',()=>{expect(SEED_SHELTERS).toHaveLength(4);expect(SEED_SHELTERS.filter(s=>s.verification_status==='verified')).toHaveLength(3);expect(SEED_SHELTERS.filter(s=>s.verification_status==='pending')).toHaveLength(1)});
 it('defines 36 pets',()=>{expect(pets).toHaveLength(36)});
 it('defines 10 applications',()=>{expect(SEED_APPLICATIONS).toHaveLength(10)});
 it('contains 16 dogs, 14 cats and 6 rabbits',()=>{expect(pets.filter(p=>p.species==='dog')).toHaveLength(16);expect(pets.filter(p=>p.species==='cat')).toHaveLength(14);expect(pets.filter(p=>p.species==='rabbit')).toHaveLength(6)});
 it('leaves two pets pending and two adopted after application lifecycle updates',()=>{const approved=SEED_APPLICATIONS.filter(a=>a.finalStatus==='approved').map(a=>a.petName);const completed=SEED_APPLICATIONS.filter(a=>a.finalStatus==='completed').map(a=>a.petName);expect(approved).toEqual(['Miso','Rocky']);expect(completed).toEqual(['Biscuit','Bruno']);expect(approved).toHaveLength(2);expect(completed).toHaveLength(2);for(const name of [...approved,...completed])expect(pets.some(p=>p.name===name)).toBe(true)});
 it('defines two bonded pairs',()=>{const pairs=new Set(pets.map(p=>p._bondKey).filter(Boolean));expect(pairs.size).toBe(2);expect(pets.filter(p=>p._bondKey).length).toBe(4)});
 it('covers all five application statuses',()=>{expect(new Set(SEED_APPLICATIONS.map(a=>a.finalStatus))).toEqual(new Set(['submitted','under_review','approved','rejected','completed']))});
});
