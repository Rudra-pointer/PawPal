import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireRole } from './auth.js';
import { applicationError, submitApplication, transitionApplication, updateApplicationChecks } from '../services/applicationFlow.js';
import { applicationIdSchema, applicationListQuerySchema, createApplicationSchema, transitionSchema, updateChecksSchema } from '../schemas/applications.js';

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const applicationsRouter = Router();
export const shelterAdoptionsRouter = Router();
const adopterOnly = requireRole('adopter');
const shelterOnly = requireRole('shelter');

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw Object.assign(new Error('Please check the highlighted fields.'), {
    status: 400, errorCode: 'VALIDATION_ERROR', details: result.error.issues,
  });
  return result.data;
}

async function detailFor(actor, id) {
  const { rows } = await query(`
    SELECT a.*, p.name AS pet_name,p.species,p.status AS pet_status,p.shelter_id,
           s.name AS shelter_name,s.owner_user_id,s.verification_status,
           u.id AS applicant_id,u.name AS applicant_account_name
      FROM applications a
      JOIN pets p ON p.id=a.pet_id
      JOIN shelters s ON s.id=p.shelter_id
      JOIN users u ON u.id=a.adopter_id
     WHERE a.id=$1
  `, [id]);
  const row = rows[0];
  if (!row) throw applicationError(404, 'NOT_FOUND', 'Application not found.');
  const allowed = actor.role === 'admin'
    || (actor.role === 'adopter' && actor.id === row.adopter_id)
    || (actor.role === 'shelter' && actor.id === row.owner_user_id && row.verification_status === 'verified');
  if (!allowed) throw applicationError(403, 'FORBIDDEN', 'You do not have access to this application.');
  const [events, checks] = await Promise.all([
    query('SELECT id,from_status,to_status,actor_id,note,created_at FROM application_events WHERE application_id=$1 ORDER BY created_at,id', [id]),
    query('SELECT check_type,result,notes,checked_by,checked_at FROM application_checks WHERE application_id=$1 ORDER BY check_type', [id]),
  ]);
  return {
    ...row,
    applicant: { id: row.applicant_id, name: row.applicant_name, email: row.applicant_email, city: row.city, state: row.state },
    pet: { id: row.pet_id, name: row.pet_name, species: row.species, status: row.pet_status },
    shelter: { id: row.shelter_id, name: row.shelter_name },
    events: events.rows,
    checks: checks.rows,
  };
}

async function assertShelter(actor) {
  const { rows } = await query(`
    SELECT id,verification_status FROM shelters WHERE owner_user_id=$1
  `, [actor.id]);
  if (!rows[0]) throw applicationError(403, 'FORBIDDEN', 'Your shelter profile is unavailable.');
  if (rows[0].verification_status !== 'verified') throw applicationError(403, 'SHELTER_UNVERIFIED', 'A verified shelter is required to manage applications.');
  return rows[0].id;
}

shelterAdoptionsRouter.get('/summary', ...shelterOnly, asyncHandler(async (req, res) => {
  const shelterId = await assertShelter(req.user);
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM pets WHERE shelter_id=$1 AND status <> 'removed') AS active_pets,
      (SELECT count(*)::int FROM applications WHERE shelter_id=$1 AND status IN ('submitted','under_review')) AS open_applications,
      (SELECT count(*)::int FROM applications WHERE shelter_id=$1 AND status='submitted') AS submitted,
      (SELECT count(*)::int FROM applications WHERE shelter_id=$1 AND status='completed') AS completed
  `, [shelterId]);
  const row = rows[0];
  res.json({ activePets: row.active_pets, openApplications: row.open_applications, submitted: row.submitted, completed: row.completed });
}));

applicationsRouter.post('/', ...adopterOnly, asyncHandler(async (req, res) => {
  const data = parse(createApplicationSchema, req.body);
  const application = await withTransaction(client => submitApplication(client, { adopterId: req.user.id, data }));
  res.status(201).json({ application });
}));

applicationsRouter.get('/mine', ...adopterOnly, asyncHandler(async (req, res) => {
  const { page, pageSize } = parse(applicationListQuerySchema, req.query);
  const count = await query("SELECT count(*)::int AS total FROM applications WHERE adopter_id=$1", [req.user.id]);
  const counts = await query('SELECT status,count(*)::int AS count FROM applications WHERE adopter_id=$1 GROUP BY status', [req.user.id]);
  const { rows } = await query(`
    SELECT a.id,a.status,a.submitted_at,a.updated_at,a.decision_note,a.risk_flags,
           p.id AS pet_id,p.name AS pet_name,p.species,p.status AS pet_status,
           (SELECT json_agg(json_build_object('id',e.id,'fromStatus',e.from_status,'toStatus',e.to_status,'note',e.note,'createdAt',e.created_at) ORDER BY e.created_at,e.id)
              FROM application_events e WHERE e.application_id=a.id) AS events
      FROM applications a JOIN pets p ON p.id=a.pet_id
     WHERE a.adopter_id=$1 ORDER BY a.submitted_at DESC,a.id
     LIMIT $2 OFFSET $3
  `, [req.user.id, pageSize, (page - 1) * pageSize]);
  const total = count.rows[0].total;
  res.json({ items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize), statusCounts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])) });
}));

applicationsRouter.get('/shelter', ...shelterOnly, asyncHandler(async (req, res) => {
  const shelterId = await assertShelter(req.user);
  const { status, q, page, pageSize } = parse(applicationListQuerySchema, req.query);
  const filterValues = [shelterId, status ?? null, q];
  const count = await query(`
    SELECT count(*)::int AS total
      FROM applications a JOIN pets p ON p.id=a.pet_id
     WHERE a.shelter_id=$1
       AND ($2::application_status IS NULL OR a.status=$2::application_status)
       AND ($3='' OR a.applicant_name ILIKE '%'||$3||'%' OR a.applicant_email ILIKE '%'||$3||'%' OR p.name ILIKE '%'||$3||'%')
  `, filterValues);
  const counts = await query(`SELECT status,count(*)::int AS count FROM applications WHERE shelter_id=$1 GROUP BY status`, [shelterId]);
  const { rows } = await query(`
    SELECT a.id,a.status,a.submitted_at,a.applicant_name,a.city,a.state,a.risk_flags,
           p.id AS pet_id,p.name AS pet_name,p.species
      FROM applications a JOIN pets p ON p.id=a.pet_id
     WHERE a.shelter_id=$1
       AND ($2::application_status IS NULL OR a.status=$2::application_status)
       AND ($3='' OR a.applicant_name ILIKE '%'||$3||'%' OR a.applicant_email ILIKE '%'||$3||'%' OR p.name ILIKE '%'||$3||'%')
     ORDER BY a.submitted_at DESC,a.id
     LIMIT $4 OFFSET $5
  `, [...filterValues, pageSize, (page - 1) * pageSize]);
  const total = count.rows[0].total;
  res.json({ items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize), statusCounts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])) });
}));

applicationsRouter.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = parse(applicationIdSchema, req.params);
  res.json({ application: await detailFor(req.user, id) });
}));

applicationsRouter.patch('/:id/checks', ...shelterOnly, asyncHandler(async (req, res) => {
  const { id } = parse(applicationIdSchema, req.params);
  const { checks } = parse(updateChecksSchema, req.body);
  const result = await withTransaction(client => updateApplicationChecks(client, { applicationId: id, checks, actor: req.user }));
  res.json({ checks: result.rows });
}));

applicationsRouter.patch('/:id/status', ...shelterOnly, asyncHandler(async (req, res) => {
  const { id } = parse(applicationIdSchema, req.params);
  const { to, note } = parse(transitionSchema, req.body);
  const application = await withTransaction(client => transitionApplication(client, { applicationId: id, to, actor: req.user, note }));
  res.json({ application });
}));

shelterAdoptionsRouter.get('/adoption-records', ...shelterOnly, asyncHandler(async (req, res) => {
  const shelterId = await assertShelter(req.user);
  const { page, pageSize } = parse(applicationListQuerySchema, req.query);
  const count = await query("SELECT count(*)::int AS total FROM applications WHERE shelter_id=$1 AND status='completed'", [shelterId]);
  const stats = await query(`
    SELECT count(*) FILTER (WHERE completed_at >= date_trunc('year',now()))::int AS completed_this_year,
           round(avg(extract(epoch FROM (completed_at-submitted_at))/86400.0)::numeric,1) AS average_days
      FROM applications WHERE shelter_id=$1 AND status='completed'
  `, [shelterId]);
  const { rows } = await query(`
    SELECT a.id,a.completed_at,a.applicant_name,a.city,a.state,p.id AS pet_id,p.name AS pet_name,p.species
      FROM applications a JOIN pets p ON p.id=a.pet_id
     WHERE a.shelter_id=$1 AND a.status='completed'
     ORDER BY a.completed_at DESC,a.id LIMIT $2 OFFSET $3
  `, [shelterId, pageSize, (page - 1) * pageSize]);
  const total = count.rows[0].total;
  res.json({ items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize), stats: { completedThisYear: stats.rows[0].completed_this_year, averageDays: stats.rows[0].average_days } });
}));

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

shelterAdoptionsRouter.get('/adoption-records.csv', ...shelterOnly, asyncHandler(async (req, res) => {
  const shelterId = await assertShelter(req.user);
  const { rows } = await query(`
    SELECT p.name AS pet_name,a.applicant_name,a.applicant_email,a.completed_at,a.city,a.state
      FROM applications a JOIN pets p ON p.id=a.pet_id
     WHERE a.shelter_id=$1 AND a.status='completed' ORDER BY a.completed_at DESC,a.id
  `, [shelterId]);
  const output = [['Pet','Adopter','Email','Completed','City','State'], ...rows.map(row => [row.pet_name,row.applicant_name,row.applicant_email,row.completed_at?.toISOString(),row.city,row.state])]
    .map(row => row.map(csvCell).join(',')).join('\r\n');
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="pawpal-adoptions.csv"').send(output);
}));
