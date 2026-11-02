BEGIN;

ALTER TABLE pets ALTER COLUMN species TYPE text USING species::text;
ALTER TABLE vaccine_types ALTER COLUMN species TYPE text USING species::text;
ALTER TABLE vaccine_types ADD COLUMN IF NOT EXISTS is_generic boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pets_species_normalized') THEN
    ALTER TABLE pets ADD CONSTRAINT ck_pets_species_normalized
      CHECK (species = lower(btrim(species)) AND length(species) BETWEEN 1 AND 40
        AND species ~ '^[[:alpha:]][[:alpha:] -]*$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_vaccine_species_normalized') THEN
    ALTER TABLE vaccine_types ADD CONSTRAINT ck_vaccine_species_normalized
      CHECK (species = '__generic__' OR (species = lower(btrim(species)) AND length(species) BETWEEN 1 AND 40
        AND species ~ '^[[:alpha:]][[:alpha:] -]*$'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pets_before_write() RETURNS trigger AS $$
BEGIN
  NEW.age_group := CASE NEW.species
    WHEN 'dog' THEN CASE WHEN NEW.age_months < 12 THEN 'baby'::age_group_type WHEN NEW.age_months < 48 THEN 'young'::age_group_type WHEN NEW.age_months < 96 THEN 'adult'::age_group_type ELSE 'senior'::age_group_type END
    WHEN 'cat' THEN CASE WHEN NEW.age_months < 12 THEN 'baby'::age_group_type WHEN NEW.age_months < 48 THEN 'young'::age_group_type WHEN NEW.age_months < 120 THEN 'adult'::age_group_type ELSE 'senior'::age_group_type END
    WHEN 'rabbit' THEN CASE WHEN NEW.age_months < 4 THEN 'baby'::age_group_type WHEN NEW.age_months < 24 THEN 'young'::age_group_type WHEN NEW.age_months < 72 THEN 'adult'::age_group_type ELSE 'senior'::age_group_type END
    ELSE CASE WHEN NEW.age_months < 12 THEN 'baby'::age_group_type WHEN NEW.age_months < 48 THEN 'young'::age_group_type WHEN NEW.age_months < 120 THEN 'adult'::age_group_type ELSE 'senior'::age_group_type END
  END;
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

INSERT INTO vaccine_types (species, code, name, description, is_core, first_dose_weeks, is_generic)
VALUES ('__generic__', 'OTHER', 'Other / veterinarian-recommended',
  'Use for a vaccine recommended by a veterinarian when no species-specific option is listed.', false, NULL, true)
ON CONFLICT (species, code) DO UPDATE SET is_generic = true;

COMMIT;
