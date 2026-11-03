import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';

function duplicateFieldError(field) {
  const isEmail = field === 'email';
  const message = isEmail ? 'That email is already in use.' : 'That User ID is already in use.';
  return Object.assign(new Error(message), {
    status: 409,
    errorCode: isEmail ? 'EMAIL_TAKEN' : 'USER_ID_TAKEN',
    details: [{ path: [isEmail ? 'email' : 'userCode'], message }],
  });
}

export async function createRegisteredUser(data, queryFn = query, hashPassword = bcrypt.hash) {
  const passwordHash = await hashPassword(data.password, 10);
  try {
    const result = await queryFn(
      `INSERT INTO users (user_code,name,email,contact_no,password_hash,role)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,user_code,name,email,role,status`,
      [data.userCode, data.name, data.email, data.contactNo || null, passwordHash, data.role],
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'ux_users_email') throw duplicateFieldError('email');
    if (error.code === '23505' && error.constraint === 'ux_users_user_code') throw duplicateFieldError('userCode');
    throw error;
  }
}
