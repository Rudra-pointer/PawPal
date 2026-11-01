-- =====================================================================
-- PawPal  |  Step 2 of 2  |  Schema + reference data (PostgreSQL 13 or newer)
-- Safe to run more than once. Run it while connected to the "pawpal" database
-- (and again on "pawpal_test"). In pgAdmin: right-click the database > Query Tool,
-- paste this whole file, press F5.
-- =====================================================================
BEGIN;

-- ---------- ENUM TYPES (idempotent) ----------
DO $$ BEGIN CREATE TYPE user_role          AS ENUM ('adopter','shelter','admin');                                   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE account_status     AS ENUM ('active','suspended','removed');                               EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE verification_state AS ENUM ('pending','verified','rejected');                              EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE species_type       AS ENUM ('dog','cat','rabbit');                                         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE age_group_type     AS ENUM ('baby','young','adult','senior');                              EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gender_type        AS ENUM ('male','female','unknown');                                    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE size_type          AS ENUM ('small','medium','large','xlarge');                            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE energy_type        AS ENUM ('low','medium','high');                                        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tri_state          AS ENUM ('yes','no','unknown');                                         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE pet_status         AS ENUM ('available','pending','adopted','removed');                    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE application_status AS ENUM ('submitted','under_review','approved','rejected','completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE home_type          AS ENUM ('apartment','house_no_yard','house_with_yard','farm_acreage'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE ownership_type     AS ENUM ('own','rent','family_home');                                   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE experience_level   AS ENUM ('first_time','some','experienced');                            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE check_type        AS ENUM ('identity','address','landlord_permission','household_agreement','home_check','vet_reference','interview'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE check_result       AS ENUM ('pending','passed','failed','not_applicable');                 EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE report_target      AS ENUM ('pet','user','shelter','application');                         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE report_state       AS ENUM ('open','in_review','resolved','dismissed');                    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- helper trigger functions ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- Life-stage rules (typical vet guidelines, tuned to match the PawPal UI):
--   dog    baby <12 mo | young 12-47 mo | adult 48-95 mo | senior 96+ mo
--   cat    baby <12 mo | young 12-47 mo | adult 48-119 mo | senior 120+ mo
--   rabbit baby < 4 mo | young 4-23 mo  | adult 24-71 mo | senior 72+ mo
CREATE OR REPLACE FUNCTION pets_before_write() RETURNS trigger AS $$
BEGIN
  NEW.age_group := CASE NEW.species
    WHEN 'dog'    THEN CASE WHEN NEW.age_months < 12 THEN 'baby'::age_group_type WHEN NEW.age_months < 48 THEN 'young'::age_group_type WHEN NEW.age_months < 96  THEN 'adult'::age_group_type ELSE 'senior'::age_group_type END
    WHEN 'cat'    THEN CASE WHEN NEW.age_months < 12 THEN 'baby'::age_group_type WHEN NEW.age_months < 48 THEN 'young'::age_group_type WHEN NEW.age_months < 120 THEN 'adult'::age_group_type ELSE 'senior'::age_group_type END
    ELSE               CASE WHEN NEW.age_months < 4  THEN 'baby'::age_group_type WHEN NEW.age_months < 24 THEN 'young'::age_group_type WHEN NEW.age_months < 72  THEN 'adult'::age_group_type ELSE 'senior'::age_group_type END
  END;
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- ---------- USERS ----------
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_code      text NOT NULL CHECK (user_code ~ '^[A-Za-z0-9_.-]{3,30}$'),   -- the SRS "user id"
  name           text NOT NULL CHECK (length(trim(name)) >= 2),
  email          text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_no     text,
  password_hash  text NOT NULL,
  role           user_role NOT NULL DEFAULT 'adopter',
  status         account_status NOT NULL DEFAULT 'active',
  city           text,
  state          text,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email     ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_user_code ON users (lower(user_code));

-- ---------- SHELTERS ----------
CREATE TABLE IF NOT EXISTS shelters (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  name                 text NOT NULL CHECK (length(trim(name)) >= 2),
  description          text NOT NULL DEFAULT '',
  address_line         text NOT NULL,
  city                 text NOT NULL,
  state                text NOT NULL,
  postcode             text,
  country              text NOT NULL DEFAULT 'US',
  contact_email        text NOT NULL,
  contact_phone        text,
  website              text,
  verification_status  verification_state NOT NULL DEFAULT 'pending',
  verification_note    text,
  verified_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_shelters_status ON shelters (verification_status);
CREATE INDEX IF NOT EXISTS ix_shelters_city   ON shelters (lower(city));

CREATE TABLE IF NOT EXISTS shelter_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shelter_id   uuid NOT NULL REFERENCES shelters(id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  mime_type    text NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
  byte_size    integer NOT NULL CHECK (byte_size BETWEEN 1 AND 3145728),
  data         bytea NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_shelter_docs_shelter ON shelter_documents (shelter_id);

-- ---------- PETS ----------
CREATE TABLE IF NOT EXISTS pets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shelter_id          uuid NOT NULL REFERENCES shelters(id) ON DELETE RESTRICT,
  name                text NOT NULL CHECK (length(trim(name)) >= 1),
  species             species_type NOT NULL,
  breed               text NOT NULL DEFAULT 'Mixed breed',
  age_months          integer NOT NULL CHECK (age_months BETWEEN 2 AND 300),   -- pets under 8 weeks are not adoptable
  age_group           age_group_type NOT NULL DEFAULT 'young',                  -- filled by trigger from species + age_months
  gender              gender_type NOT NULL DEFAULT 'unknown',
  size                size_type NOT NULL,
  weight_kg           numeric(5,1) CHECK (weight_kg IS NULL OR weight_kg > 0),
  coat                text,
  colors              text[] NOT NULL DEFAULT '{}',
  description         text NOT NULL DEFAULT '',
  temperament         text[] NOT NULL DEFAULT '{}' CHECK (temperament <@ ARRAY['playful','calm','affectionate','gentle','curious','energetic','independent','shy','social','protective','vocal','quiet','cuddly','loyal','food_motivated','trainable']::text[]),
  energy_level        energy_type NOT NULL DEFAULT 'medium',
  spayed_neutered     boolean NOT NULL DEFAULT false,
  microchipped        boolean NOT NULL DEFAULT false,
  house_trained       boolean NOT NULL DEFAULT false,       -- dogs: house-trained | cats/rabbits: litter-trained
  special_needs       boolean NOT NULL DEFAULT false,
  special_needs_notes text,
  health_notes        text,
  good_with_children  tri_state NOT NULL DEFAULT 'unknown',
  good_with_dogs      tri_state NOT NULL DEFAULT 'unknown',
  good_with_cats      tri_state NOT NULL DEFAULT 'unknown',
  bonded_pet_id       uuid REFERENCES pets(id) ON DELETE SET NULL,   -- bonded pairs are best adopted together
  status              pet_status NOT NULL DEFAULT 'available',
  source              text NOT NULL DEFAULT 'local' CHECK (source IN ('local','seed','petfinder')),
  external_id         text,
  source_url          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  removed_at          timestamptz,
  CHECK (bonded_pet_id IS NULL OR bonded_pet_id <> id)
);
CREATE INDEX IF NOT EXISTS ix_pets_browse   ON pets (status, species, age_group, size);
CREATE INDEX IF NOT EXISTS ix_pets_shelter  ON pets (shelter_id, status);
CREATE INDEX IF NOT EXISTS ix_pets_newest   ON pets (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pets_external ON pets (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pets_search   ON pets USING gin (to_tsvector('simple', name || ' ' || breed || ' ' || description));
DROP TRIGGER IF EXISTS trg_pets_write ON pets;
CREATE TRIGGER trg_pets_write BEFORE INSERT OR UPDATE ON pets FOR EACH ROW EXECUTE FUNCTION pets_before_write();

CREATE TABLE IF NOT EXISTS pet_photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id     uuid NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  position   smallint NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  url        text,                        -- external image (seed data, e.g. Unsplash)
  data       bytea,                       -- or an uploaded, resized image stored here
  mime_type  text,
  byte_size  integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((url IS NOT NULL) <> (data IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_pet_photos_pet ON pet_photos (pet_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pet_photos_primary ON pet_photos (pet_id) WHERE is_primary;

-- ---------- VACCINES ----------
CREATE TABLE IF NOT EXISTS vaccine_types (
  id                 smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  species            species_type NOT NULL,
  code               text NOT NULL,
  name               text NOT NULL,
  description        text NOT NULL,
  is_core            boolean NOT NULL DEFAULT false,
  first_dose_weeks   smallint,           -- typical earliest age; guideline only, vets decide
  UNIQUE (species, code)
);
CREATE TABLE IF NOT EXISTS pet_vaccinations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id           uuid NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  vaccine_type_id  smallint NOT NULL REFERENCES vaccine_types(id),
  given_on         date NOT NULL CHECK (given_on <= CURRENT_DATE + 1),
  next_due_on      date,
  clinic           text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (next_due_on IS NULL OR next_due_on > given_on),
  UNIQUE (pet_id, vaccine_type_id, given_on)
);
CREATE INDEX IF NOT EXISTS ix_pet_vacc_pet ON pet_vaccinations (pet_id);

-- ---------- SAVED PETS (favourites) ----------
CREATE TABLE IF NOT EXISTS saved_pets (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id     uuid NOT NULL REFERENCES pets(id)  ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pet_id)
);

-- ---------- APPLICATIONS ----------
CREATE TABLE IF NOT EXISTS applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id             uuid NOT NULL REFERENCES pets(id)  ON DELETE RESTRICT,
  adopter_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shelter_id         uuid NOT NULL REFERENCES shelters(id) ON DELETE RESTRICT,   -- filled by trigger from the pet
  status             application_status NOT NULL DEFAULT 'submitted',
  applicant_name     text NOT NULL,
  applicant_email    text NOT NULL,
  contact_no         text NOT NULL,
  address_line       text NOT NULL,
  city               text NOT NULL,
  state              text,
  postcode           text,
  home_type          home_type NOT NULL,
  ownership          ownership_type NOT NULL,
  household_adults   smallint NOT NULL DEFAULT 1 CHECK (household_adults BETWEEN 1 AND 20),
  has_children       boolean NOT NULL DEFAULT false,
  youngest_child_age smallint CHECK (youngest_child_age IS NULL OR youngest_child_age BETWEEN 0 AND 17),
  other_pets         text NOT NULL DEFAULT '',
  experience         experience_level NOT NULL,
  hours_alone_per_day smallint NOT NULL DEFAULT 4 CHECK (hours_alone_per_day BETWEEN 0 AND 24),
  reason             text NOT NULL CHECK (length(trim(reason)) >= 10),
  risk_flags         jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_note      text,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_at        timestamptz,
  decided_at         timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- DATABASE-ENFORCED RULES (the app cannot break these, even with a bug):
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_open_per_adopter ON applications (pet_id, adopter_id) WHERE status IN ('submitted','under_review','approved');
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_one_approved     ON applications (pet_id) WHERE status = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_one_completed    ON applications (pet_id) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS ix_app_shelter_status ON applications (shelter_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_adopter        ON applications (adopter_id, submitted_at DESC);

CREATE OR REPLACE FUNCTION applications_before_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT shelter_id INTO NEW.shelter_id FROM pets WHERE id = NEW.pet_id;
    IF NEW.shelter_id IS NULL THEN RAISE EXCEPTION 'pet % does not exist', NEW.pet_id; END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_applications_write ON applications;
CREATE TRIGGER trg_applications_write BEFORE INSERT OR UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION applications_before_write();

CREATE TABLE IF NOT EXISTS application_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status    application_status,
  to_status      application_status NOT NULL,
  actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_app_events_app ON application_events (application_id, created_at);

CREATE TABLE IF NOT EXISTS application_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  check_type     check_type NOT NULL,
  result         check_result NOT NULL DEFAULT 'pending',
  notes          text,
  checked_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  checked_at     timestamptz,
  UNIQUE (application_id, check_type)
);

-- ---------- REPORTS, AUDIT, MATCH HISTORY ----------
CREATE TABLE IF NOT EXISTS reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type      report_target NOT NULL,
  target_id        uuid NOT NULL,
  reason           text NOT NULL CHECK (reason IN ('inaccurate_information','duplicate_listing','inappropriate_content','suspected_scam','animal_welfare_concern','other')),
  details          text NOT NULL DEFAULT '',
  status           report_state NOT NULL DEFAULT 'open',
  admin_action     text,
  resolution_note  text,
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_reports_status ON reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS match_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  answers     jsonb NOT NULL,
  top_pet_ids uuid[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- updated_at triggers ----------
DROP TRIGGER IF EXISTS trg_users_updated    ON users;    CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_shelters_updated ON shelters; CREATE TRIGGER trg_shelters_updated BEFORE UPDATE ON shelters FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- REFERENCE DATA: vaccines (typical guidelines; the shelter's vet decides) ----------
INSERT INTO vaccine_types (species, code, name, description, is_core, first_dose_weeks) VALUES
 ('dog','RABIES',     'Rabies',                          'Required by law in many places. First dose from about 12 weeks, then boosters as the vet or local law directs.', true, 12),
 ('dog','DHPP',       'DHPP / DHPPi (5-in-1)',           'Distemper, hepatitis (adenovirus), parvovirus, parainfluenza. Puppies: from 6-8 weeks, boosters every 3-4 weeks until about 16 weeks.', true, 6),
 ('dog','LEPTO',      'Leptospirosis',                   'Risk-based; common where dogs meet standing water or wildlife. Two doses a few weeks apart, then yearly.', false, 12),
 ('dog','BORDETELLA', 'Bordetella (kennel cough)',       'Risk-based; advised before boarding, daycare or group classes.', false, 8),
 ('cat','RABIES',     'Rabies',                          'Required by law in many places. First dose from about 12 weeks.', true, 12),
 ('cat','FVRCP',      'FVRCP (3-in-1 / Tricat)',         'Feline viral rhinotracheitis, calicivirus, panleukopenia. Kittens: from 6-8 weeks, boosters every 3-4 weeks until about 16 weeks.', true, 6),
 ('cat','FELV',       'Feline leukaemia (FeLV)',         'Risk-based; strongly advised for kittens and for any cat that goes outdoors or meets unknown cats.', false, 8),
 ('rabbit','RHDV2',   'Rabbit haemorrhagic disease (RHDV2)', 'Availability depends on the country; ask a rabbit-savvy vet. Annual booster where available.', false, NULL),
 ('rabbit','MYXO',    'Myxomatosis',                     'Availability depends on the country (common in the UK, Europe, Australia). Ask a rabbit-savvy vet.', false, NULL)
ON CONFLICT (species, code) DO NOTHING;

-- ---------- VIEWS used by the dashboards ----------
CREATE OR REPLACE VIEW v_shelter_stats AS
SELECT s.id AS shelter_id,
       count(p.*) FILTER (WHERE p.status <> 'removed')                        AS total_pets,
       count(p.*) FILTER (WHERE p.status = 'available')                       AS available_pets,
       (SELECT count(*) FROM applications a WHERE a.shelter_id = s.id AND a.status IN ('submitted','under_review')) AS open_applications,
       (SELECT count(*) FROM applications a WHERE a.shelter_id = s.id AND a.status = 'completed'
                AND a.completed_at >= date_trunc('year', now()))               AS completed_this_year
FROM shelters s LEFT JOIN pets p ON p.shelter_id = s.id
GROUP BY s.id;

CREATE OR REPLACE VIEW v_admin_stats AS
SELECT (SELECT count(*) FROM users WHERE status <> 'removed')                          AS users_total,
       (SELECT count(*) FROM users WHERE status = 'suspended')                         AS users_suspended,
       (SELECT count(*) FROM shelters WHERE verification_status = 'pending')           AS shelters_pending,
       (SELECT count(*) FROM pets WHERE status = 'available')                          AS pets_available,
       (SELECT count(*) FROM applications WHERE status IN ('submitted','under_review')) AS applications_open,
       (SELECT count(*) FROM applications WHERE status = 'completed')                  AS adoptions_completed,
       (SELECT count(*) FROM reports WHERE status IN ('open','in_review'))             AS reports_open;

COMMIT;
