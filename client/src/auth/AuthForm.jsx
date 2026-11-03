import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/http.js';
import {
  buildRegistrationPayload,
  registrationAutocomplete,
  registrationFieldErrors,
  USER_ID_PATTERN,
  validateRegistration,
} from './registration.js';

function FieldError({ id, message }) {
  return message ? <small id={id} role="alert">{message}</small> : null;
}

export default function AuthForm({ mode, auth, notify, BrandMark }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [role, setRole] = useState('adopter');
  const [availability, setAvailability] = useState({ email: 'idle', userCode: 'idle' });
  const requestSequence = useRef({ email: 0, userCode: 0 });
  const currentValue = useRef({ email: '', userCode: '' });

  useEffect(() => {
    const targets = [...document.querySelectorAll('.auth-card')];
    targets.forEach(element => element.classList.add('scroll-reveal'));
    if (typeof IntersectionObserver !== 'function') {
      targets.forEach(element => element.classList.add('in-view'));
      return undefined;
    }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    }), { threshold: .12 });
    targets.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  const checkAvailability = async (field, rawValue) => {
    const value = String(rawValue || '').trim();
    currentValue.current[field] = value;
    const valid = field === 'email'
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      : USER_ID_PATTERN.test(value);
    if (!valid) {
      setAvailability(state => ({ ...state, [field]: 'invalid' }));
      setFieldErrors(state => ({
        ...state,
        [field]: field === 'email' ? 'Enter a valid email address.' : 'Use 3–30 letters, numbers, dots, underscores or hyphens.',
      }));
      return false;
    }

    const sequence = ++requestSequence.current[field];
    setAvailability(state => ({ ...state, [field]: 'loading' }));
    setFieldErrors(state => ({ ...state, [field]: '' }));
    try {
      const query = field === 'email' ? `email=${encodeURIComponent(value)}` : `userCode=${encodeURIComponent(value)}`;
      const result = await api(`/auth/availability?${query}`);
      if (sequence !== requestSequence.current[field] || currentValue.current[field] !== value) return false;
      setAvailability(state => ({ ...state, [field]: result.available ? 'available' : 'taken' }));
      if (!result.available) {
        setFieldErrors(state => ({ ...state, [field]: field === 'email' ? 'This email is already in use.' : 'This User ID is already in use.' }));
      }
      return result.available;
    } catch {
      if (sequence !== requestSequence.current[field] || currentValue.current[field] !== value) return false;
      setAvailability(state => ({ ...state, [field]: 'error' }));
      setFieldErrors(state => ({ ...state, [field]: 'Availability could not be checked. Try again.' }));
      return false;
    }
  };

  const changeAvailabilityField = field => event => {
    currentValue.current[field] = event.target.value.trim();
    requestSequence.current[field] += 1;
    setAvailability(state => ({ ...state, [field]: 'idle' }));
    setFieldErrors(state => ({ ...state, [field]: '' }));
  };

  const submit = async event => {
    event.preventDefault();
    setError('');
    setFieldErrors({});
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      let user;
      if (mode === 'login') {
        user = await auth.login({ identifier: data.identifier.trim(), password: data.password });
      } else {
        const values = {
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          userCode: data.pawpalNewUserId,
          password: data.password,
          role,
        };
        const validationErrors = validateRegistration(values);
        if (Object.keys(validationErrors).length) {
          setFieldErrors(validationErrors);
          setError('Please correct the highlighted fields.');
          return;
        }
        const [emailAvailable, userCodeAvailable] = await Promise.all([
          checkAvailability('email', values.email),
          checkAvailability('userCode', values.userCode),
        ]);
        if (!emailAvailable || !userCodeAvailable) {
          setError('Please correct the highlighted fields.');
          return;
        }
        user = await auth.register(buildRegistrationPayload({ ...values, phone: data.phone }));
      }

      const requested = new URLSearchParams(loc.search).get('next');
      const next = requested?.startsWith('/') && !requested.startsWith('//')
        ? requested
        : ({ adopter: '/me', shelter: '/shelter/register', admin: '/admin' }[user.role]);
      if (mode === 'login' && user.role !== role) {
        notify(`This account is registered as ${user.role}. Taking you to your ${user.role} workspace.`);
      }
      nav(next);
    } catch (requestError) {
      const specificErrors = registrationFieldErrors(requestError.details);
      setFieldErrors(specificErrors);
      setError(Object.keys(specificErrors).length ? 'Please correct the highlighted fields.' : requestError.message);
      notify(requestError.message);
    }
  };

  const roleChoices = mode === 'login'
    ? [['adopter', 'Adopter'], ['shelter', 'Shelter / volunteer'], ['admin', 'Admin']]
    : [['adopter', 'Adopter'], ['shelter', 'Shelter / volunteer']];
  const userIdStatus = availability.userCode === 'loading'
    ? 'Checking availability…'
    : availability.userCode === 'available' ? 'User ID is available.' : '';
  const emailStatus = availability.email === 'loading'
    ? 'Checking availability…'
    : availability.email === 'available' ? 'Email is available.' : '';

  return <main className="view show"><section className="auth"><div className="auth-card">
    <div className="auth-art"><div><div className="brand"><BrandMark /><span>Paw<em>Pal</em></span></div>
      <h2>{mode === 'login' ? <>Come for the pets.<br />Stay for the feeling.</> : <>A softer way<br />to start.</>}</h2>
      <p>{mode === 'login' ? 'One account keeps your applications, matches, and favorite pets in one place.' : 'Tell us a little about yourself. We’ll make the rest feel simple.'}</p>
    </div><img className="auth-dog" src={mode === 'login' ? 'https://images.unsplash.com/photo-1548767797-d8c844163c4c?auto=format&fit=crop&w=700&q=80' : 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=700&q=80'} alt={mode === 'login' ? 'Dog' : 'Rescue dog'} /></div>
    <form className="auth-form" onSubmit={submit}>
      <div className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Create your account'}</div>
      <h1>{mode === 'login' ? 'Good to see you.' : 'Let’s make it official.'}</h1>
      <p>{mode === 'login' ? 'Sign in to keep your adoption journey moving.' : 'It only takes a minute. Your future best friend is worth it.'}</p>
      <div className="role-pills">{roleChoices.map(([value, label]) => <button key={value} type="button" className={role === value ? 'active' : ''} aria-pressed={role === value} onClick={() => setRole(value)}>{label}</button>)}</div>
      {mode === 'register' && <>
        <div className="form-two">
          <div className="field"><label htmlFor="firstName">First name</label><input id="firstName" name="firstName" placeholder="Alex" required minLength="1" autoComplete={registrationAutocomplete.firstName} aria-invalid={Boolean(fieldErrors.firstName)} aria-describedby={fieldErrors.firstName ? 'firstName-error' : undefined} /><FieldError id="firstName-error" message={fieldErrors.firstName} /></div>
          <div className="field"><label htmlFor="lastName">Last name</label><input id="lastName" name="lastName" placeholder="Rivera" required minLength="1" autoComplete={registrationAutocomplete.lastName} aria-invalid={Boolean(fieldErrors.lastName)} aria-describedby={fieldErrors.lastName ? 'lastName-error' : undefined} /><FieldError id="lastName-error" message={fieldErrors.lastName} /></div>
        </div>
        <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" placeholder="alex@example.com" required autoComplete={registrationAutocomplete.email} aria-invalid={Boolean(fieldErrors.email)} aria-describedby={fieldErrors.email ? 'email-error' : 'email-availability'} onChange={changeAvailabilityField('email')} onBlur={event => event.target.value && checkAvailability('email', event.target.value)} /><small id="email-availability" aria-live="polite" data-state={availability.email}>{emailStatus}</small><FieldError id="email-error" message={fieldErrors.email} /></div>
        <div className="form-two">
          <div className="field"><label htmlFor="phone">Contact no.</label><input id="phone" name="phone" placeholder="+91 98765 43210" type="tel" autoComplete={registrationAutocomplete.phone} /></div>
          <div className="field"><label htmlFor="userCode">User ID</label><input id="userCode" name="pawpalNewUserId" required minLength="3" maxLength="30" pattern="[A-Za-z0-9_.-]{3,30}" title="Use 3–30 letters, numbers, dots, underscores or hyphens." autoComplete={registrationAutocomplete.userCode} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(fieldErrors.userCode)} aria-describedby={fieldErrors.userCode ? 'userCode-error' : 'userCode-availability'} onChange={changeAvailabilityField('userCode')} onBlur={event => event.target.value && checkAvailability('userCode', event.target.value)} /><small id="userCode-availability" aria-live="polite" data-state={availability.userCode}>{userIdStatus}</small><FieldError id="userCode-error" message={fieldErrors.userCode} /></div>
        </div>
      </>}
      {mode === 'login' && <div className="field"><label htmlFor="identifier">Email or user ID</label><input id="identifier" name="identifier" autoComplete="username" placeholder="you@example.com" required /></div>}
      <div className="field"><label htmlFor="password">{mode === 'login' ? 'Password' : 'Create password'}</label><input id="password" name="password" type="password" placeholder={mode === 'login' ? '••••••••' : 'At least 8 characters'} required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : registrationAutocomplete.password} aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? 'password-error' : undefined} /><FieldError id="password-error" message={fieldErrors.password} /></div>
      {mode === 'login' && <div className="form-foot"><label><input type="checkbox" /> Remember me</label><a href="#forgot" onClick={event => { event.preventDefault(); notify('Password reset is not available yet.'); }}>Forgot password?</a></div>}
      <p role="alert">{error}</p>
      <button className="btn lime full">{mode === 'login' ? 'Sign in securely ↗' : 'Create my PawPal account ↗'}</button>
      <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, marginTop: 22 }}>{mode === 'login' ? 'New to PawPal?' : 'Already have an account?'} <Link to={mode === 'login' ? '/register' : '/login'} style={{ color: 'var(--green2)', fontWeight: 700 }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</Link></div>
    </form>
  </div></section></main>;
}
