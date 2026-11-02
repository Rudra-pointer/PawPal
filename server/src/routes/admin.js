import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { requireRole } from './auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { speciesNameSchema } from '../schemas/species.js';

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const idSchema = z.object({ id: z.string().uuid() });
const pageSchema = z.object({ q: z.string().trim().max(120).optional().default(''), role: z.enum(['adopter','shelter','admin']).optional(), status: z.enum(['active','suspended','removed']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(12) });
const reportReasons = ['inaccurate_information','duplicate_listing','inappropriate_content','suspected_scam','animal_welfare_concern','other'];
const reportCreate = z.object({ targetType: z.enum(['pet','user','shelter','application']), targetId: z.string().uuid(), reason: z.enum(reportReasons), details: z.string().trim().max(2000).default('') });
const reportResolution = z.object({ action: z.enum(['dismiss','remove_listing','suspend_user']), note: z.string().trim().min(1).max(2000) });
const verification = z.object({ action: z.enum(['verify','reject']), reason: z.string().trim().max(2000).optional() }).superRefine((value, ctx) => { if (value.action === 'reject' && !value.reason?.trim()) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A reason is required when rejecting a shelter.' }); });
const statusChange = z.object({ status: z.enum(['suspend','activate']) });
const listingQuery = z.object({ q: z.string().trim().max(120).optional().default(''), status: z.enum(['available','pending','adopted','removed']).optional(), species: speciesNameSchema.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(12) });

function fail(status, code, message) { return Object.assign(new Error(message), { status, errorCode: code }); }
function parsed(schema, value) { const result = schema.safeParse(value); if (!result.success) throw Object.assign(new Error('Please check the submitted fields.'), { status: 400, errorCode: 'VALIDATION_ERROR', details: result.error.issues }); return result.data; }
async function audit(client, actorId, action, targetType, targetId, details = {}) { await client.query('INSERT INTO audit_log (actor_id,action,target_type,target_id,details) VALUES ($1,$2,$3,$4,$5::jsonb)', [actorId,action,targetType,String(targetId),JSON.stringify(details)]); }

export const adminRouter = Router();
adminRouter.use(...requireRole('admin'));

adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  const { rows } = await query('SELECT * FROM v_admin_stats');
  res.json(rows[0] ?? {});
}));

adminRouter.get('/users', asyncHandler(async (req, res) => {
  const filters = parsed(pageSchema, req.query);
  const { rows } = await query(`
    WITH filtered AS (
      SELECT id,user_code,name,email,role,status,city,state,created_at
        FROM users WHERE ($1='' OR name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR user_code ILIKE '%'||$1||'%')
          AND ($2::user_role IS NULL OR role=$2::user_role) AND ($3::account_status IS NULL OR status=$3::account_status)
    ), counted AS (SELECT count(*)::int total FROM filtered)
    SELECT counted.total, page.* FROM counted LEFT JOIN LATERAL (
      SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT $4 OFFSET $5
    ) page ON true ORDER BY page.created_at DESC,page.id
  `, [filters.q,filters.role ?? null,filters.status ?? null,filters.pageSize,(filters.page-1)*filters.pageSize]);
  const total = rows[0]?.total ?? 0;
  res.json({ items: rows.filter(row => row.id),total,page:filters.page,pageSize:filters.pageSize,totalPages:Math.ceil(total/filters.pageSize) });
}));

adminRouter.patch('/users/:id/status', asyncHandler(async (req, res) => {
  const { id } = parsed(idSchema, req.params), { status } = parsed(statusChange, req.body);
  const user = await withTransaction(async client => {
    await client.query("SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE");
    const selected = await client.query('SELECT id,role,status FROM users WHERE id=$1 FOR UPDATE', [id]);
    const target = selected.rows[0];
    if (!target) throw fail(404,'NOT_FOUND','User not found.');
    if (id === req.user.id && status === 'suspend') {
      if (target.role === 'admin' && target.status === 'active') {
        const active = await client.query("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id FOR UPDATE");
        if (active.rowCount <= 1) throw fail(409,'LAST_ACTIVE_ADMIN','The last active administrator cannot be suspended.');
      }
      throw fail(422,'SELF_ACTION_FORBIDDEN','You cannot suspend your own account.');
    }
    if (target.role === 'admin' && target.status === 'active' && status === 'suspend') {
      const active = await client.query("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id FOR UPDATE");
      if (active.rowCount <= 1) throw fail(409,'LAST_ACTIVE_ADMIN','The last active administrator cannot be suspended.');
    }
    const nextStatus = status === 'suspend' ? 'suspended' : 'active';
    const updated = await client.query('UPDATE users SET status=$2::account_status WHERE id=$1 RETURNING id,user_code,name,email,role,status', [id,nextStatus]);
    await audit(client,req.user.id,`user.${status}`,'user',id,{ from:target.status,to:nextStatus });
    return updated.rows[0];
  });
  res.json({ user });
}));

adminRouter.delete('/users/:id', asyncHandler(async (req, res) => {
  const { id } = parsed(idSchema, req.params);
  if (id === req.user.id) throw fail(422,'SELF_ACTION_FORBIDDEN','You cannot remove your own account.');
  await withTransaction(async client => {
    await client.query("SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE");
    const selected = await client.query('SELECT id,role,status FROM users WHERE id=$1 FOR UPDATE', [id]);
    const target = selected.rows[0];
    if (!target) throw fail(404,'NOT_FOUND','User not found.');
    if (target.role === 'admin' && target.status === 'active') {
      const active = await client.query("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id FOR UPDATE");
      if (active.rowCount <= 1) throw fail(409,'LAST_ACTIVE_ADMIN','The last active administrator cannot be removed.');
    }
    await client.query("UPDATE users SET status='removed' WHERE id=$1", [id]);
    await audit(client,req.user.id,'user.remove','user',id,{ from:target.status,to:'removed' });
  });
  res.json({ removed:true,id });
}));

adminRouter.get('/shelters', asyncHandler(async (req, res) => {
  const status = z.enum(['pending','verified','rejected']).optional().safeParse(req.query.status);
  if (!status.success) throw Object.assign(new Error('Choose a valid shelter status.'),{status:400,errorCode:'VALIDATION_ERROR',details:status.error.issues});
  const { rows } = await query(`SELECT s.id,s.name,s.city,s.state,s.verification_status,s.verification_note,s.created_at,u.name AS owner_name,u.email AS owner_email,(SELECT count(*)::int FROM shelter_documents d WHERE d.shelter_id=s.id) document_count FROM shelters s JOIN users u ON u.id=s.owner_user_id WHERE ($1::verification_state IS NULL OR s.verification_status=$1::verification_state) ORDER BY (s.verification_status='pending') DESC,s.created_at,s.id LIMIT 50`,[status.data ?? null]);
  res.json({ items:rows });
}));

adminRouter.get('/shelters/:id/documents', asyncHandler(async (req,res)=>{
  const { id }=parsed(idSchema,req.params);
  const result=await query('SELECT id,file_name,mime_type,byte_size,uploaded_at FROM shelter_documents WHERE shelter_id=$1 ORDER BY uploaded_at,id',[id]);
  res.json({items:result.rows});
}));

adminRouter.get('/documents/:id', asyncHandler(async(req,res)=>{
  const {id}=parsed(idSchema,req.params);
  const {rows}=await query('SELECT file_name,mime_type,data FROM shelter_documents WHERE id=$1',[id]);
  if(!rows[0]) throw fail(404,'NOT_FOUND','Shelter document not found.');
  res.set('Content-Type',rows[0].mime_type).set('Content-Disposition',`inline; filename="${rows[0].file_name.replace(/["\\\r\n]/g,'_')}"`).set('X-Content-Type-Options','nosniff').send(rows[0].data);
}));

adminRouter.patch('/shelters/:id/verification',asyncHandler(async(req,res)=>{
  const {id}=parsed(idSchema,req.params), change=parsed(verification,req.body);
  const shelter=await withTransaction(async client=>{
    const selected=await client.query('SELECT id,verification_status FROM shelters WHERE id=$1 FOR UPDATE',[id]);
    if(!selected.rows[0]) throw fail(404,'NOT_FOUND','Shelter not found.');
    const next=change.action==='verify'?'verified':'rejected';
    const updated=await client.query('UPDATE shelters SET verification_status=$2::verification_state,verification_note=$3,verified_by=$4,verified_at=CASE WHEN $2=\'verified\' THEN now() ELSE NULL END WHERE id=$1 RETURNING id,name,verification_status,verification_note,verified_by,verified_at',[id,next,change.action==='reject'?change.reason:null,req.user.id]);
    await audit(client,req.user.id,`shelter.${change.action}`,'shelter',id,{reason:change.reason ?? null});
    return updated.rows[0];
  });
  res.json({shelter});
}));

adminRouter.get('/pets',asyncHandler(async(req,res)=>{
  const f=parsed(listingQuery,req.query);
  const {rows}=await query(`WITH filtered AS (SELECT p.id,p.name,p.species,p.status,p.breed,p.created_at,s.name AS shelter_name FROM pets p JOIN shelters s ON s.id=p.shelter_id JOIN users u ON u.id=s.owner_user_id WHERE ($1='' OR p.name ILIKE '%'||$1||'%' OR p.breed ILIKE '%'||$1||'%' OR s.name ILIKE '%'||$1||'%') AND ($2::pet_status IS NULL OR p.status=$2::pet_status) AND ($3::text IS NULL OR p.species=$3)), counted AS (SELECT count(*)::int total FROM filtered) SELECT counted.total,page.* FROM counted LEFT JOIN LATERAL(SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT $4 OFFSET $5) page ON true ORDER BY page.created_at DESC,page.id`,[f.q,f.status ?? null,f.species ?? null,f.pageSize,(f.page-1)*f.pageSize]);
  const total=rows[0]?.total ?? 0;res.json({items:rows.filter(row=>row.id),total,page:f.page,pageSize:f.pageSize,totalPages:Math.ceil(total/f.pageSize)});
}));

adminRouter.delete('/pets/:id',asyncHandler(async(req,res)=>{
  const {id}=parsed(idSchema,req.params),body=z.object({reason:z.string().trim().min(1).max(2000)}).safeParse(req.body);
  if(!body.success) throw Object.assign(new Error('A removal reason is required.'),{status:400,errorCode:'VALIDATION_ERROR',details:body.error.issues});
  await withTransaction(async client=>{
    const pet=await client.query('SELECT id,status FROM pets WHERE id=$1 FOR UPDATE',[id]);
    if(!pet.rows[0])throw fail(404,'NOT_FOUND','Pet not found.');
    await client.query("UPDATE pets SET status='removed',removed_at=COALESCE(removed_at,now()) WHERE id=$1",[id]);
    await audit(client,req.user.id,'listing.remove','pet',id,{reason:body.data.reason});
  });res.json({removed:true,id});
}));

adminRouter.get('/applications',asyncHandler(async(req,res)=>{
  const schema=z.object({status:z.enum(['submitted','under_review','approved','rejected','completed']).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(50).default(12)}),f=parsed(schema,req.query);
  const {rows}=await query(`WITH filtered AS (SELECT a.id,a.status,a.submitted_at,a.pet_id,p.name AS pet_name,a.adopter_id,u.name AS adopter_name,a.shelter_id,s.name AS shelter_name FROM applications a JOIN pets p ON p.id=a.pet_id JOIN users u ON u.id=a.adopter_id JOIN shelters s ON s.id=a.shelter_id WHERE ($1::application_status IS NULL OR a.status=$1::application_status)),counted AS(SELECT count(*)::int total FROM filtered) SELECT counted.total,page.* FROM counted LEFT JOIN LATERAL(SELECT * FROM filtered ORDER BY submitted_at DESC,id LIMIT $2 OFFSET $3) page ON true ORDER BY page.submitted_at DESC,page.id`,[f.status ?? null,f.pageSize,(f.page-1)*f.pageSize]);const total=rows[0]?.total ?? 0;res.json({items:rows.filter(row=>row.id),total,page:f.page,pageSize:f.pageSize,totalPages:Math.ceil(total/f.pageSize)});
}));

adminRouter.get('/reports',asyncHandler(async(req,res)=>{
  const status=z.enum(['open','in_review','resolved','dismissed']).optional().safeParse(req.query.status);if(!status.success)throw Object.assign(new Error('Choose a valid report status.'),{status:400,errorCode:'VALIDATION_ERROR',details:status.error.issues});
  const {rows}=await query(`SELECT r.*,u.name AS reporter_name,CASE r.target_type WHEN 'pet' THEN (SELECT name FROM pets WHERE id=r.target_id) WHEN 'user' THEN (SELECT name FROM users WHERE id=r.target_id) WHEN 'shelter' THEN (SELECT name FROM shelters WHERE id=r.target_id) ELSE NULL END AS target_name FROM reports r JOIN users u ON u.id=r.reporter_id WHERE ($1::report_state IS NULL OR r.status=$1::report_state) ORDER BY (r.status IN ('open','in_review')) DESC,r.created_at DESC,r.id LIMIT 50`,[status.data ?? null]);res.json({items:rows});
}));

adminRouter.patch('/reports/:id',asyncHandler(async(req,res)=>{
  const {id}=parsed(idSchema,req.params),change=parsed(reportResolution,req.body);
  const report=await withTransaction(async client=>{
    const selected=await client.query('SELECT * FROM reports WHERE id=$1 FOR UPDATE',[id]);const current=selected.rows[0];if(!current)throw fail(404,'NOT_FOUND','Report not found.');if(!['open','in_review'].includes(current.status))throw fail(409,'REPORT_ALREADY_CLOSED','This report has already been resolved.');
    if(change.action==='remove_listing'){
      if(current.target_type!=='pet')throw fail(422,'INVALID_REPORT_ACTION','Only a pet report can remove a listing.');
      const pet=await client.query('SELECT id FROM pets WHERE id=$1 FOR UPDATE',[current.target_id]);if(!pet.rows[0])throw fail(404,'NOT_FOUND','Reported pet not found.');
      await client.query("UPDATE pets SET status='removed',removed_at=COALESCE(removed_at,now()) WHERE id=$1",[current.target_id]);
    }
    if(change.action==='suspend_user'){
      const targetId=current.target_type==='user'?current.target_id:current.target_type==='shelter'?(await client.query('SELECT owner_user_id AS id FROM shelters WHERE id=$1 FOR UPDATE',[current.target_id])).rows[0]?.id:null;
      if(!targetId)throw fail(422,'INVALID_REPORT_ACTION','This report does not identify a suspendable user or shelter.');
      const target=await client.query('SELECT id,role,status FROM users WHERE id=$1 FOR UPDATE',[targetId]);if(!target.rows[0])throw fail(404,'NOT_FOUND','Reported user not found.');if(targetId===req.user.id)throw fail(422,'SELF_ACTION_FORBIDDEN','You cannot suspend your own account.');
      if(target.rows[0].role==='admin'&&target.rows[0].status==='active'){const active=await client.query("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id FOR UPDATE");if(active.rowCount<=1)throw fail(409,'LAST_ACTIVE_ADMIN','The last active administrator cannot be suspended.');}
      await client.query("UPDATE users SET status='suspended' WHERE id=$1",[targetId]);
    }
    const next=change.action==='dismiss'?'dismissed':'resolved';
    const updated=await client.query('UPDATE reports SET status=$2::report_state,admin_action=$3,resolution_note=$4,resolved_by=$5,resolved_at=now() WHERE id=$1 RETURNING *',[id,next,change.action,change.note,req.user.id]);
    await audit(client,req.user.id,`report.${change.action}`,current.target_type,current.target_id,{reportId:id,reason:change.note});return updated.rows[0];
  });res.json({report});
}));

adminRouter.get('/audit',asyncHandler(async(_req,res)=>{const {rows}=await query('SELECT l.id,l.actor_id,u.name AS actor_name,l.action,l.target_type,l.target_id,l.details,l.created_at FROM audit_log l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.created_at DESC,l.id DESC LIMIT 50');res.json({items:rows});}));

export const reportsRouter=Router();
reportsRouter.post('/',rateLimit({max:30,keyPrefix:'reports',code:'REPORT_RATE_LIMITED',message:'Too many reports. Please try again later.'}),...requireRole('adopter','shelter'),asyncHandler(async(req,res)=>{
  const data=parsed(reportCreate,req.body);
  const created=await withTransaction(async client=>{
    const actor=await client.query('SELECT id,status,role FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);if(!actor.rows[0]||actor.rows[0].status!=='active'||!['adopter','shelter'].includes(actor.rows[0].role))throw fail(403,'FORBIDDEN','An active adopter or shelter account is required.');
    const target=await client.query(`
      SELECT EXISTS(SELECT 1 FROM pets WHERE id=$1 AND $2::text='pet')
          OR EXISTS(SELECT 1 FROM users WHERE id=$1 AND $2::text='user')
          OR EXISTS(SELECT 1 FROM shelters WHERE id=$1 AND $2::text='shelter')
          OR EXISTS(SELECT 1 FROM applications WHERE id=$1 AND $2::text='application') AS present
    `,[data.targetId,data.targetType]);if(!target.rows[0].present)throw fail(404,'NOT_FOUND','The reported item was not found.');
    const existing=await client.query("SELECT id FROM reports WHERE reporter_id=$1 AND target_type=$2::report_target AND target_id=$3 AND status IN ('open','in_review') FOR UPDATE",[req.user.id,data.targetType,data.targetId]);if(existing.rowCount)throw fail(409,'DUPLICATE_REPORT','You already have an open report for this item.');
    const {rows}=await client.query('INSERT INTO reports (reporter_id,target_type,target_id,reason,details) VALUES ($1,$2::report_target,$3,$4,$5) RETURNING *',[req.user.id,data.targetType,data.targetId,data.reason,data.details]);return rows[0];
  });res.status(201).json({report:created});
}));
