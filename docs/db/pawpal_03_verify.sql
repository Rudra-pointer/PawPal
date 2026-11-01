-- =====================================================================
-- PawPal  |  Optional checks to run in pgAdmin after the schema (and after seeding)
-- =====================================================================
-- 1) Every table that should exist (expect 14 rows)
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1;

-- 2) Vaccine reference data (expect 9 rows)
SELECT species, code, name, is_core FROM vaccine_types ORDER BY species, is_core DESC, code;

-- 3) The database-enforced rules (expect 3 rows: ux_app_one_approved, ux_app_one_completed, ux_app_open_per_adopter)
SELECT indexname FROM pg_indexes WHERE tablename = 'applications' AND indexname LIKE 'ux_app_%' ORDER BY 1;

-- 4) After seeding: row counts
SELECT 'users' t, count(*) FROM users UNION ALL SELECT 'shelters', count(*) FROM shelters
UNION ALL SELECT 'pets', count(*) FROM pets UNION ALL SELECT 'pet_photos', count(*) FROM pet_photos
UNION ALL SELECT 'applications', count(*) FROM applications;

-- 5) After seeding: pets per species and status
SELECT species, status, count(*) FROM pets GROUP BY 1,2 ORDER BY 1,2;

-- 6) Dashboard views
SELECT * FROM v_admin_stats;
SELECT s.name, v.* FROM v_shelter_stats v JOIN shelters s ON s.id = v.shelter_id;

-- 7) Which pets are hidden from the public site (removed) and which are waiting on an adopter (pending)
SELECT name, species, status FROM pets WHERE status IN ('pending','removed') ORDER BY status, name;
