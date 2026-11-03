export const USER_ID_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
export const registrationAutocomplete = Object.freeze({
  firstName: 'given-name',
  lastName: 'family-name',
  email: 'email',
  phone: 'tel',
  userCode: 'off',
  password: 'new-password',
});

export function validateRegistration(values) {
  const errors = {};
  if (!String(values.firstName || '').trim()) errors.firstName = 'Enter your first name.';
  if (!String(values.lastName || '').trim()) errors.lastName = 'Enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email || '').trim())) {
    errors.email = 'Enter a valid email address.';
  }
  if (!USER_ID_PATTERN.test(String(values.userCode || '').trim())) {
    errors.userCode = 'Use 3–30 letters, numbers, dots, underscores or hyphens.';
  }
  if (String(values.password || '').length < 8 || !/[A-Za-z]/.test(values.password) || !/[0-9]/.test(values.password)) {
    errors.password = 'Use at least 8 characters, including a letter and a number.';
  }
  if (!['adopter', 'shelter'].includes(values.role)) errors.role = 'Choose adopter or shelter registration.';
  return errors;
}

export function buildRegistrationPayload(values) {
  return {
    name: `${String(values.firstName || '').trim()} ${String(values.lastName || '').trim()}`.trim(),
    email: String(values.email || '').trim(),
    userCode: String(values.userCode || '').trim(),
    contactNo: String(values.phone || '').trim(),
    password: values.password,
    role: values.role,
  };
}

export function registrationFieldErrors(details = []) {
  const errors = {};
  for (const issue of details) {
    const path = Array.isArray(issue.path) ? issue.path[0] : null;
    if (!path) continue;
    const field = path === 'name' ? 'firstName' : path === 'contactNo' ? 'phone' : path;
    errors[field] ||= issue.message || 'Check this field.';
  }
  return errors;
}
