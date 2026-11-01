# PawPal - Project Context (read this first, every session)

PawPal is a pet adoption web platform (Group 10 course project). Adopters search pets, take a smart-match quiz,
apply to adopt and track the application. Shelters/volunteers list pets and review applications. Admins verify
shelters, moderate listings and handle reports. The visual design is FINAL and lives in
`docs/frontend-reference/PawPal_Premium.html`. Never change the look, copy, colours or animations.

## Stack (fixed - do not swap)
- Frontend: React 18 + Vite + React Router, plain CSS copied from the reference HTML, no UI library.
- Backend: Node 20+, Express, ES modules, `pg` (node-postgres) with parameterised SQL (no ORM), zod validation.
- Database: PostgreSQL 13+ (pgAdmin on the dev machine, Neon in production). Schema = `docs/db/pawpal_02_schema.sql`.
- Auth: bcryptjs + JWT in an httpOnly cookie (`pawpal_token`). No tokens in localStorage.
- Uploads: multer (memory) + sharp; images/documents are stored in PostgreSQL (bytea) because the host disk is ephemeral.
- Tests: vitest + supertest against the `pawpal_test` database. Production: Express also serves `client/dist`.
- Ports: API 5000, Vite dev server 5173 (proxy `/api` to 5000). Production is a single origin, so no CORS.

## Roles
guest (browse, match quiz) | adopter (apply, track, save, report) | shelter (own pets and applications, only after admin
verification) | admin (users, shelter verification, listings, applications, reports, audit log). Roles are enforced on the
server by middleware; hiding buttons in the UI is only cosmetic.

## SRS modules -> prompts
M1 Registration and login (prompt 2) | M2 Pet discovery (3) | M3 Adoption management (4) | M4 Shelter management and
M5 Admin management (5) | M6 Smart matching and pet pairing (6) | hardening, tests, deploy (7). Prompt 1 = foundation.

## Statuses
- Pet: available, pending (an application is approved), adopted, removed (soft delete, hidden from public).
- Application: submitted -> under_review -> approved -> completed; or rejected (from under_review/approved).
  Approving needs every REQUIRED check passed. Transitions run in ONE transaction with row locks.
  The database also enforces: one open application per adopter per pet, one approved application per pet.
- Shelter verification: pending -> verified | rejected. Unverified shelters cannot publish pets.

## API conventions
- JSON only. Success: the resource or `{items,total,page,pageSize,totalPages}`.
- Errors: `{ "error": { "code": "SNAKE_UPPER", "message": "Friendly sentence", "details": [...] } }` with correct HTTP codes
  (400 validation, 401 not logged in, 403 wrong role, 404, 409 conflict/invalid transition, 422 rule violation, 429 rate limit).
- Every list endpoint paginates (default 12, max 24 for pets, max 50 elsewhere).
- Never interpolate user input into SQL. Always `$1, $2` parameters. Always check ownership (shelter A cannot touch shelter B).

## Pet-expert rules the code must respect
Life stage (age_group is set by a DB trigger): dog baby <12 mo, young 12-47, adult 48-95, senior 96+ | cat baby <12,
young 12-47, adult 48-119, senior 120+ | rabbit baby <4, young 4-23, adult 24-71, senior 72+.
Size guide (adult weight): small <10 kg, medium 10-25 kg, large 25-45 kg, xlarge >45 kg.
Minimum adoptable age is 8 weeks (2 months). Cats and rabbits are litter-trained, dogs are house-trained.
Core vaccines (typical guideline, vets decide): dog = rabies + DHPP; cat = rabies + FVRCP; rabbits are region dependent.
Vaccine status shown on a profile: up_to_date, due_soon (next due within 30 days), overdue, not_recorded.
Good-with flags are tri-state yes/no/unknown. Unknown is NOT a yes: show "Not yet assessed".
Rabbits are social: pairs (bonded) are ideal. Bonded pets (bonded_pet_id) should be adopted together.
Temperament vocabulary: playful, calm, affectionate, gentle, curious, energetic, independent, shy, social, protective,
vocal, quiet, cuddly, loyal, food_motivated, trainable.
Required adoption checks before approval: identity, address, household_agreement, and landlord_permission when the
adopter rents, plus at least one of home_check or interview. vet_reference is recommended, not required.
Risk flags are advice for the shelter, never an automatic rejection.

## Definition of done for any task
Runs locally, tests pass (`npm test`), no console errors in the browser, empty/loading/error states exist, mobile layout
works at 375 px, no secrets committed, and the walkthrough lists the exact commands and outputs you verified.
