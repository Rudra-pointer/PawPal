import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegistrationPayload, registrationAutocomplete, registrationFieldErrors, validateRegistration } from './registration.js';

const valid = {
  firstName: 'Alex', lastName: 'Rivera', email: 'alex@example.com',
  userCode: 'Alex_R', password: 'PawPal123', role: 'adopter',
};

test('accepts a valid adopter and shelter registration form', () => {
  assert.deepEqual(validateRegistration(valid), {});
  assert.deepEqual(validateRegistration({ ...valid, role: 'shelter' }), {});
});

test('rejects email-style, too-short and too-long user IDs with a field error', () => {
  for (const userCode of ['alex@example.com', 'ab', 'a'.repeat(31)]) {
    assert.match(validateRegistration({ ...valid, userCode }).userCode, /3–30/);
  }
});

test('requires a password with eight characters, a letter, and a number', () => {
  for (const password of ['short1', '12345678', 'abcdefgh']) {
    assert.match(validateRegistration({ ...valid, password }).password, /letter and a number/);
  }
});

test('maps backend validation and duplicate errors to visible form fields', () => {
  assert.deepEqual(registrationFieldErrors([
    { path: ['userCode'], message: 'Invalid user ID.' },
    { path: ['email'], message: 'That email is already in use.' },
  ]), {
    userCode: 'Invalid user ID.',
    email: 'That email is already in use.',
  });
});

test('uses registration-specific autocomplete values to keep User ID out of saved login autofill', () => {
  assert.deepEqual(registrationAutocomplete, {
    firstName: 'given-name', lastName: 'family-name', email: 'email',
    phone: 'tel', userCode: 'off', password: 'new-password',
  });
});

test('includes the optional contact number in the registration API payload', () => {
  assert.deepEqual(buildRegistrationPayload({ ...valid, phone: '  +1 555 123 4567  ' }), {
    name: 'Alex Rivera', email: 'alex@example.com', userCode: 'Alex_R',
    contactNo: '+1 555 123 4567', password: 'PawPal123', role: 'adopter',
  });
});
