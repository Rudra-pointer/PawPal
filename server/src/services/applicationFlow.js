import { computeRiskFlags } from './applicationRisk.js';

export const APPLICATION_TRANSITIONS = Object.freeze({
  submitted: ['under_review'],
  under_review: ['approved', 'rejected'],
  approved: ['completed', 'rejected'],
  rejected: [],
  completed: [],
});

export function applicationError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.errorCode = code;
  return error;
}

async function lockApplicationAndPet(client, applicationId) {
  const found = await client.query('SELECT pet_id FROM applications WHERE id=$1', [applicationId]);
  if (!found.rows[0]) throw applicationError(404, 'NOT_FOUND', 'Application not found.');
  const petResult = await client.query(`
    SELECT p.id,p.status,p.shelter_id,s.owner_user_id,s.verification_status
      FROM pets p JOIN shelters s ON s.id=p.shelter_id
     WHERE p.id=$1 FOR UPDATE OF p,s
  `, [found.rows[0].pet_id]);
  const appResult = await client.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [applicationId]);
  if (!appResult.rows[0] || !petResult.rows[0]) throw applicationError(404, 'NOT_FOUND', 'Application not found.');
  return { application: appResult.rows[0], pet: petResult.rows[0] };
}

function assertShelterOwner(actor, pet) {
  if (actor.role !== 'shelter' || pet.owner_user_id !== actor.id) {
    throw applicationError(403, 'FORBIDDEN', 'You do not have access to this application.');
  }
  if (pet.verification_status !== 'verified') {
    throw applicationError(403, 'SHELTER_UNVERIFIED', 'A verified shelter is required to manage applications.');
  }
}

export async function transitionApplication(client, { applicationId, to, actor, note = null }) {
  const { application, pet } = await lockApplicationAndPet(client, applicationId);
  assertShelterOwner(actor, pet);
  if (!APPLICATION_TRANSITIONS[application.status]?.includes(to)) {
    throw applicationError(409, 'INVALID_TRANSITION', 'This application cannot move to that status.');
  }
  if (to === 'rejected' && !note?.trim()) {
    throw applicationError(400, 'VALIDATION_ERROR', 'A note is required when rejecting an application.');
  }

  if (to === 'under_review') {
    const required = [
      ['identity', 'pending'], ['address', 'pending'], ['household_agreement', 'pending'],
      ['landlord_permission', application.ownership === 'rent' ? 'pending' : 'not_applicable'],
      ['home_check', 'pending'], ['interview', 'pending'], ['vet_reference', 'pending'],
    ];
    for (const [type, result] of required) {
      await client.query(`
        INSERT INTO application_checks (application_id,check_type,result)
        VALUES ($1,$2::check_type,$3::check_result) ON CONFLICT (application_id,check_type) DO NOTHING
      `, [applicationId, type, result]);
    }
    await client.query('UPDATE applications SET reviewed_at=COALESCE(reviewed_at,now()) WHERE id=$1', [applicationId]);
  }

  if (to === 'approved') {
    if (pet.status !== 'available') throw applicationError(409, 'PET_UNAVAILABLE', 'This pet is no longer available.');
    const checks = await client.query('SELECT check_type,result FROM application_checks WHERE application_id=$1', [applicationId]);
    const results = new Map(checks.rows.map(row => [row.check_type, row.result]));
    const alwaysRequired = ['identity', 'address', 'household_agreement'];
    const missing = alwaysRequired.filter(type => results.get(type) !== 'passed');
    if (application.ownership === 'rent' && results.get('landlord_permission') !== 'passed') missing.push('landlord_permission');
    if (application.ownership !== 'rent' && results.get('landlord_permission') !== 'not_applicable') missing.push('landlord_permission');
    if (results.get('home_check') !== 'passed' && results.get('interview') !== 'passed') missing.push('home_check or interview');
    if (missing.length) throw applicationError(422, 'REQUIRED_CHECKS_INCOMPLETE', `Complete required checks before approval: ${missing.join(', ')}.`);
    const updatePet = await client.query("UPDATE pets SET status='pending' WHERE id=$1 AND status='available'", [pet.id]);
    if (updatePet.rowCount !== 1) throw applicationError(409, 'PET_UNAVAILABLE', 'This pet is no longer available.');
  }

  if (to === 'rejected' && application.status === 'approved' && pet.status === 'pending') {
    await client.query("UPDATE pets SET status='available' WHERE id=$1 AND status='pending'", [pet.id]);
  }

  if (to === 'completed') {
    if (pet.status !== 'pending') throw applicationError(409, 'PET_UNAVAILABLE', 'This pet is not pending adoption.');
    const updatePet = await client.query("UPDATE pets SET status='adopted' WHERE id=$1 AND status='pending'", [pet.id]);
    if (updatePet.rowCount !== 1) throw applicationError(409, 'PET_UNAVAILABLE', 'This pet is not pending adoption.');
  }

  const changed = await client.query(`
    UPDATE applications
       SET status=$2::application_status, decision_note=$3,
           reviewed_at=CASE WHEN $2='under_review' THEN COALESCE(reviewed_at,now()) ELSE reviewed_at END,
           decided_at=CASE WHEN $2 IN ('approved','rejected') THEN now() ELSE decided_at END,
           completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END
     WHERE id=$1 RETURNING *
  `, [applicationId, to, note?.trim() || null]);
  await client.query(`
    INSERT INTO application_events (application_id,from_status,to_status,actor_id,note)
    VALUES ($1,$2::application_status,$3::application_status,$4,$5)
  `, [applicationId, application.status, to, actor.id, note?.trim() || null]);

  if (to === 'completed') {
    const others = await client.query(`
      WITH open_apps AS (
        SELECT id,status AS from_status FROM applications
         WHERE pet_id=$1 AND id<>$2 AND status IN ('submitted','under_review','approved')
      )
      UPDATE applications a SET status='rejected',decision_note='Pet adopted by another applicant',decided_at=now()
       FROM open_apps o WHERE a.id=o.id
       RETURNING a.id,o.from_status
    `, [pet.id, applicationId]);
    for (const other of others.rows) {
      await client.query(`
        INSERT INTO application_events (application_id,from_status,to_status,actor_id,note)
        VALUES ($1,$2::application_status,'rejected',$3,'Pet adopted by another applicant')
      `, [other.id, other.from_status, actor.id]);
    }
  }
  return changed.rows[0];
}

export async function updateApplicationChecks(client, { applicationId, checks, actor }) {
  const { application, pet } = await lockApplicationAndPet(client, applicationId);
  assertShelterOwner(actor, pet);
  if (application.status !== 'under_review') {
    throw applicationError(409, 'INVALID_TRANSITION', 'Checks can only be updated while an application is under review.');
  }
  for (const check of checks) {
    if (check.checkType === 'landlord_permission') {
      const expected = application.ownership === 'rent' ? ['pending', 'passed', 'failed'] : ['not_applicable'];
      if (!expected.includes(check.result)) {
        throw applicationError(422, 'RULE_VIOLATION', application.ownership === 'rent'
          ? 'Landlord permission must be checked for renters.'
          : 'Landlord permission must be not applicable when the adopter does not rent.');
      }
    } else if (check.result === 'not_applicable') {
      throw applicationError(422, 'RULE_VIOLATION', 'This check cannot be marked not applicable.');
    }
    const updated = await client.query(`
      UPDATE application_checks
         SET result=$3::check_result,notes=$4,checked_by=$5,checked_at=CASE WHEN $3='pending' THEN NULL ELSE now() END
       WHERE application_id=$1 AND check_type=$2::check_type
       RETURNING id
    `, [applicationId, check.checkType, check.result, check.notes ?? null, actor.id]);
    if (!updated.rowCount) throw applicationError(422, 'RULE_VIOLATION', 'Start the review before updating its checks.');
  }
  return client.query('SELECT * FROM application_checks WHERE application_id=$1 ORDER BY check_type', [applicationId]);
}

export async function submitApplication(client, { adopterId, data }) {
  const adopter = await client.query("SELECT id,status,role FROM users WHERE id=$1 FOR UPDATE", [adopterId]);
  if (!adopter.rows[0] || adopter.rows[0].status !== 'active' || adopter.rows[0].role !== 'adopter') {
    throw applicationError(403, 'ACCOUNT_UNAVAILABLE', 'An active adopter account is required.');
  }
  const petResult = await client.query(`
    SELECT p.*,s.verification_status FROM pets p
      JOIN shelters s ON s.id=p.shelter_id
     WHERE p.id=$1 FOR UPDATE OF p,s
  `, [data.petId]);
  const pet = petResult.rows[0];
  if (!pet || pet.status === 'removed') throw applicationError(404, 'NOT_FOUND', 'Pet not found.');
  if (pet.status !== 'available') throw applicationError(409, 'PET_UNAVAILABLE', 'This pet is not available for applications.');
  if (pet.verification_status !== 'verified') throw applicationError(422, 'SHELTER_UNVERIFIED', 'Applications require a verified shelter.');

  const count = await client.query(`
    SELECT count(*)::int AS total FROM applications
     WHERE adopter_id=$1 AND status IN ('submitted','under_review','approved')
  `, [adopterId]);
  if (count.rows[0].total >= 3) throw applicationError(409, 'TOO_MANY_OPEN_APPLICATIONS', 'You can have at most three open applications.');

  const riskFlags = computeRiskFlags(data, pet);
  try {
    const inserted = await client.query(`
      INSERT INTO applications (
        pet_id,adopter_id,shelter_id,applicant_name,applicant_email,contact_no,address_line,city,state,postcode,
        home_type,ownership,household_adults,has_children,youngest_child_age,other_pets,experience,
        hours_alone_per_day,reason,risk_flags
      ) VALUES (
        $1,$2,(SELECT shelter_id FROM pets WHERE id=$1),$3,$4,$5,$6,$7,$8,$9,
        $10::home_type,$11::ownership_type,$12,$13,$14,$15,$16::experience_level,$17,$18,$19::jsonb
      ) RETURNING *
    `, [data.petId, adopterId, data.applicantName, data.applicantEmail, data.contactNo, data.addressLine,
      data.city, data.state ?? null, data.postcode ?? null, data.homeType, data.ownership, data.householdAdults,
      data.hasChildren, data.youngestChildAge ?? null, data.otherPets, data.experience, data.hoursAlonePerDay,
      data.reason, JSON.stringify(riskFlags)]);
    const application = inserted.rows[0];
    await client.query(`
      INSERT INTO application_events (application_id,from_status,to_status,actor_id,note)
      VALUES ($1,NULL,'submitted',$2,NULL)
    `, [application.id, adopterId]);
    return application;
  } catch (error) {
    if (error.code === '23505') throw applicationError(409, 'APPLICATION_EXISTS', 'You already have an open application for this pet.');
    throw error;
  }
}
