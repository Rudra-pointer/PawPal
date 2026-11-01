-- =====================================================================
-- PawPal  |  Step 1 of 2  |  Create the database user and the databases
-- Run in pgAdmin:  Servers > PostgreSQL > Databases > "postgres" > Query Tool
-- IMPORTANT: pgAdmin runs a whole script as ONE transaction, and CREATE DATABASE
-- cannot run inside a transaction. So run ONE statement at a time:
-- select the statement with the mouse, then press F5.
-- =====================================================================

-- 1) The application user (change the password first, and remember it for .env)
CREATE ROLE pawpal_app LOGIN PASSWORD 'ChangeMe_Strong_Pass_123';

-- 2) The main database
CREATE DATABASE pawpal OWNER pawpal_app ENCODING 'UTF8';

-- 3) A second, empty database used only by automated tests
CREATE DATABASE pawpal_test OWNER pawpal_app ENCODING 'UTF8';

-- 4) Check (run after the three statements above)
SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname LIKE 'pawpal%';
