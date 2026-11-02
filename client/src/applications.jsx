import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getPet } from './api/pets.js';
import { getAdoptionRecords, getApplication, getMyApplications, getShelterApplications, getShelterSummary, submitApplication, transitionApplication, updateApplicationChecks } from './api/applications.js';

const statusView = {
  submitted: { label: 'Submitted', className: '' },
  under_review: { label: 'Under review', className: 'wait' },
  approved: { label: 'Approved', className: 'dark' },
  rejected: { label: 'Not moving forward', className: 'red' },
  completed: { label: 'Adopted', className: '' },
};
const nextSteps = {
  submitted: 'The shelter has received your application and will review it soon.',
  under_review: 'The shelter is checking your details. They may contact you if they need anything else.',
  approved: 'Your application is approved. Contact the shelter to arrange the next steps.',
  rejected: 'The shelter has closed this application. You can continue exploring other pets.',
  completed: 'Your adoption is complete. We hope your new life together is wonderful.',
};
const checkLabels = {
  identity: 'Identity / contact', address: 'Address', landlord_permission: 'Landlord permission',
  household_agreement: 'Household agreement', home_check: 'Home check', vet_reference: 'Vet reference', interview: 'Interview',
};
const field = (label, control) => <div className="field" key={label}><label>{label}</label>{control}</div>;

function AppError({ message, retry }) {
  return <div className="empty" role="alert"><p>{message}</p>{retry && <button className="btn light small" type="button" onClick={retry}>Try again</button>}</div>;
}

export function ApplicationApplyPage({ user, onToast }) {
  const { petId } = useParams(), navigate = useNavigate();
  const [pet, setPet] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [step, setStep] = useState(1), [saving, setSaving] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [values, setValues] = useState({
    applicantName: user?.name || '', applicantEmail: user?.email || '', contactNo: '', addressLine: '', city: '', state: '', postcode: '',
    homeType: 'house_with_yard', ownership: 'own', householdAdults: 1, hasChildren: false, youngestChildAge: '', otherPets: '',
    experience: 'first_time', hoursAlonePerDay: 4, reason: '',
  });
  const [fieldError, setFieldError] = useState('');
  useEffect(() => { let active = true; setLoading(true); getPet(petId).then(result => { if (active) setPet(result); }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [petId]);
  useEffect(() => { setValues(previous => ({ ...previous, applicantName: previous.applicantName || user?.name || '', applicantEmail: previous.applicantEmail || user?.email || '' })); }, [user]);
  const set = (key, value) => setValues(current => ({ ...current, [key]: value }));
  const validateStep = () => {
    const required = step === 1
      ? [['applicantName', 'Enter your name.'], ['applicantEmail', 'Enter a valid email address.'], ['contactNo', 'Enter a contact number.'], ['addressLine', 'Enter your street address.'], ['city', 'Enter your city.']]
      : step === 2 ? [['householdAdults', 'Enter the number of adults in your household.']]
        : [['reason', 'Tell the shelter why you would like to adopt this pet.']];
    const missing = required.find(([key]) => !String(values[key] ?? '').trim());
    if (missing) { setFieldError(missing[1]); return false; }
    if (step === 1 && !/^\S+@\S+\.\S+$/.test(values.applicantEmail)) { setFieldError('Enter a valid email address.'); return false; }
    if (step === 3 && !confirmed) { setFieldError('Please confirm the application details first.'); return false; }
    setFieldError(''); return true;
  };
  const submit = async () => {
    if (!validateStep()) return;
    setSaving(true);
    try {
      const response = await submitApplication({ ...values, petId, householdAdults: Number(values.householdAdults), hasChildren: Boolean(values.hasChildren), youngestChildAge: values.hasChildren && values.youngestChildAge !== '' ? Number(values.youngestChildAge) : null, hoursAlonePerDay: Number(values.hoursAlonePerDay) });
      onToast('Application sent. The shelter will be in touch.');
      navigate('/me/applications', { state: { submittedId: response.application.id } });
    } catch (err) { setFieldError(err.message); onToast(err.message); }
    finally { setSaving(false); }
  };
  if (loading) return <main className="view show"><div className="empty">Loading pet details…</div></main>;
  if (error || !pet) return <main className="view show"><AppError message={error || 'Pet not found.'} retry={() => { setError(''); setLoading(true); getPet(petId).then(setPet).catch(err => setError(err.message)).finally(() => setLoading(false)); }} /></main>;
  if (pet.status !== 'available') return <main className="view show"><div className="flow-wrap"><div className="flow-card"><h2>This pet is {pet.status}.</h2><p className="sub">Applications are available for pets with an available status.</p><Link className="btn light" to={`/pets/${pet.id}`}>Return to {pet.name}’s profile</Link></div></div></main>;
  const homeOptions = [['apartment', 'Apartment'], ['house_no_yard', 'House without a yard'], ['house_with_yard', 'House with a yard'], ['farm_acreage', 'Farm / acreage']];
  const ownershipOptions = [['own', 'I own my home'], ['rent', 'I rent'], ['family_home', 'Family home']];
  return <main className="view show"><div className="flow-wrap">
    <div className="flow-title"><div className="eyebrow">Adopter / Application</div><h1>Bring {pet.name} home.</h1><p>A thoughtful application helps shelters make thoughtful matches.</p></div>
    <div className="steps" aria-label={`Application step ${step} of 3`}>{['About you', 'Your home', 'Review'].map((label, index) => <div className={`step ${step === index + 1 ? 'active' : ''} ${step > index + 1 ? 'done' : ''}`} key={label}><b>{index + 1}</b> {label}</div>)}</div>
    <div className="flow-card">
      {step === 1 && <div className="flow-page active"><h2>First, a little about you.</h2><p className="sub">The humans behind the home matter just as much.</p>
        <div className="form-two">{field('Full name', <input value={values.applicantName} onChange={e => set('applicantName', e.target.value)} autoComplete="name" />)}{field('Email', <input type="email" value={values.applicantEmail} onChange={e => set('applicantEmail', e.target.value)} autoComplete="email" />)}</div>
        <div className="form-two">{field('Contact no.', <input type="tel" value={values.contactNo} onChange={e => set('contactNo', e.target.value)} />)}{field('Street address', <input value={values.addressLine} onChange={e => set('addressLine', e.target.value)} autoComplete="street-address" />)}</div>
        <div className="form-two">{field('City', <input value={values.city} onChange={e => set('city', e.target.value)} autoComplete="address-level2" />)}{field('State / region', <input value={values.state} onChange={e => set('state', e.target.value)} autoComplete="address-level1" />)}</div>
        {field('Postcode', <input value={values.postcode} onChange={e => set('postcode', e.target.value)} autoComplete="postal-code" />)}
      </div>}
      {step === 2 && <div className="flow-page active"><h2>Let’s talk home.</h2><p className="sub">There is no perfect home — just an honest one.</p>
        {field('What kind of home do you live in?', <select value={values.homeType} onChange={e => set('homeType', e.target.value)}>{homeOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>)}
        {field('Living situation', <select value={values.ownership} onChange={e => set('ownership', e.target.value)}>{ownershipOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>)}
        <div className="form-two">{field('Adults in your household', <input type="number" min="1" max="20" value={values.householdAdults} onChange={e => set('householdAdults', e.target.value)} />)}{field('Hours alone per day', <input type="number" min="0" max="24" value={values.hoursAlonePerDay} onChange={e => set('hoursAlonePerDay', e.target.value)} />)}</div>
        <label className="field"><span>Do children live in your household?</span><input type="checkbox" checked={values.hasChildren} onChange={e => set('hasChildren', e.target.checked)} /></label>
        {values.hasChildren && field('Youngest child’s age', <input type="number" min="0" max="17" value={values.youngestChildAge} onChange={e => set('youngestChildAge', e.target.value)} />)}
        {field('Other pets in the home', <input value={values.otherPets} onChange={e => set('otherPets', e.target.value)} placeholder="Partner, kids, another pet..." />)}
        {field('Adoption experience', <select value={values.experience} onChange={e => set('experience', e.target.value)}><option value="first_time">First-time adopter</option><option value="some">Some experience</option><option value="experienced">Experienced</option></select>)}
      </div>}
      {step === 3 && <div className="flow-page active"><h2>Ready to send it?</h2><p className="sub">Please confirm these details before we share your application with {pet.shelter.name}.</p>
        <div className="panel" style={{ boxShadow: 'none', margin: '0 0 16px', background: 'var(--mint)' }}><b style={{ fontSize: 13 }}>Applying for {pet.name}</b><p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, margin: '7px 0 0' }}>{pet.breed} · {pet.ageLabel} · {pet.shelter.city}, {pet.shelter.state}<br />{pet.shelter.name} · {pet.shelter.verified ? 'Verified partner' : 'Partner'}</p></div>
        <div className="fact-grid"><div className="fact"><small>Home</small><b>{homeOptions.find(([value]) => value === values.homeType)?.[1]}</b></div><div className="fact"><small>Household</small><b>{values.householdAdults} adults{values.hasChildren ? ` · youngest ${values.youngestChildAge || '—'}` : ''}</b></div><div className="fact"><small>Alone time</small><b>{values.hoursAlonePerDay} hours / day</b></div></div>
        {field('Reason for adoption', <textarea rows="4" value={values.reason} onChange={e => set('reason', e.target.value)} placeholder={`Tell ${pet.shelter.name} why ${pet.name} feels like a good fit...`} />)}
        <label style={{ display: 'flex', gap: 10, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I confirm the information above is accurate and I’m ready for a meet-and-greet.</label>
      </div>}
      {fieldError && <p role="alert" style={{ color: 'var(--coral)' }}>{fieldError}</p>}
      <div className="flow-controls"><button className="btn light" type="button" disabled={step === 1 || saving} onClick={() => { setStep(value => Math.max(1, value - 1)); setFieldError(''); }}>← Back</button><button className="btn lime" type="button" disabled={saving} onClick={() => step < 3 ? (validateStep() && setStep(value => value + 1)) : submit()}>{saving ? 'Sending…' : step === 3 ? 'Submit application ↗' : 'Continue →'}</button></div>
    </div>
  </div></main>;
}

function timelineProgress(status) { return ({ submitted: 25, under_review: 55, approved: 80, rejected: 100, completed: 100 })[status] || 0; }

export function MyApplicationsPage() {
  const [result, setResult] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  useEffect(() => { let active = true; getMyApplications({ page, pageSize: 12 }).then(data => { if (active) { setResult(data); setError(''); } }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, [page, retry]);
  return <><main className="view show"><section className="page-hero"><div className="container"><div className="eyebrow">Adopter / My applications</div><h1>Keep the good<br />news close.</h1><p>Track every application from first hello to forever home.</p></div><div className="shape">♡</div></section><section className="section"><div className="container" style={{ maxWidth: 820 }}>
    {error ? <AppError message={error} retry={() => setRetry(value => value + 1)} /> : !result ? <div className="empty">Loading your applications…</div> : <div className="panel"><div className="panel-head"><h3>{result.total} application{result.total === 1 ? '' : 's'}</h3><span className="status wait">Updated today</span></div>
      {result.items.length === 0 ? <div className="empty"><p>You haven’t applied for a pet yet.</p><Link className="btn lime" to="/browse">Browse pets →</Link></div> : result.items.map(item => <article className="activity" key={item.id} style={{ alignItems: 'center' }}><div style={{ flex: 1 }}><b><Link to={`/pets/${item.pet_id}`}>{item.pet_name} · {item.species}</Link></b><span>{new Date(item.submitted_at).toLocaleDateString()} · {item.events?.length || 0} updates</span><div className="progress" style={{ marginTop: 9 }}><i style={{ width: `${timelineProgress(item.status)}%` }} /></div><p style={{ color: 'var(--muted)', fontSize: 11 }}>{nextSteps[item.status]}</p>{item.events?.length > 0 && <ol aria-label="Application timeline" style={{ color: 'var(--muted)', fontSize: 11 }}>{item.events.map(event => <li key={event.id}>{statusView[event.toStatus]?.label || event.toStatus} · {new Date(event.createdAt).toLocaleString()}</li>)}</ol>}</div><span className={`status ${statusView[item.status]?.className || ''}`}>{statusView[item.status]?.label || item.status}</span></article>)}
    </div>}
    {result?.totalPages > 1 && <nav className="pet-pagination" aria-label="Application pages"><button className="btn light small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page} of {result.totalPages}</span><button className="btn light small" disabled={page >= result.totalPages} onClick={() => setPage(value => value + 1)}>Next</button></nav>}
    <div style={{ textAlign: 'center', marginTop: 25 }}><Link className="btn lime" to="/browse">Browse more pets →</Link></div>
  </div></section></main></>;
}

export function AdopterApplicationMetric() {
  const [count, setCount] = useState(null);
  useEffect(() => { let active = true; getMyApplications({ page: 1, pageSize: 1 }).then(result => { if (active) setCount(['submitted', 'under_review', 'approved'].reduce((total, status) => total + (result.statusCounts[status] || 0), 0)); }).catch(() => { if (active) setCount(null); }); return () => { active = false; }; }, []);
  return <div className="metric"><span>Active applications</span><b>{count === null ? '—' : String(count).padStart(2, '0')}</b><i>Submitted, in review or approved</i></div>;
}

export function AdopterApplicationTimeline() {
  const [items, setItems] = useState(null);
  useEffect(() => { let active = true; getMyApplications({ page: 1, pageSize: 3 }).then(result => { if (active) setItems(result.items); }).catch(() => { if (active) setItems([]); }); return () => { active = false; }; }, []);
  return <div className="panel"><div className="panel-head"><h3>Application timeline</h3><Link to="/me/applications">View all →</Link></div>{items === null ? <div className="empty">Loading applications…</div> : items.length ? items.map(item => <Link className="activity" key={item.id} to="/me/applications"><div>🐾</div><div><b>{item.pet_name} · {statusView[item.status]?.label || item.status}</b><span>{new Date(item.submitted_at).toLocaleDateString()}</span></div><span className={`status ${statusView[item.status]?.className || ''}`} style={{ marginLeft: 'auto' }}>{statusView[item.status]?.label || item.status}</span></Link>) : <div className="empty">Your application updates will appear here.</div>}</div>;
}

export function ShelterApplicationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const status = searchParams.get('status') || '';
  const query = searchParams.get('q') || '';
  const page = Number(searchParams.get('page') || 1);
  const key = searchParams.toString();
  useEffect(() => { let active = true; const timer = setTimeout(() => { getShelterApplications({ status, q: query, page, pageSize: 12 }).then(value => { if (active) { setData(value); setError(''); } }).catch(err => { if (active) setError(err.message); }); }, 220); return () => { active = false; clearTimeout(timer); }; }, [key, retry]);
  const update = values => { const next = new URLSearchParams(searchParams); for (const [k, value] of Object.entries(values)) value ? next.set(k, value) : next.delete(k); setSearchParams(next); };
  const tabs = [['', 'All'], ['submitted', 'Submitted'], ['under_review', 'Under review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['completed', 'Completed']];
  return <main className="view show"><div className="workspace"><ApplicationSidebar active="applications" /><div className="work-main"><div className="work-head"><div><div className="eyebrow">Shelter / Application management</div><h1>People raising their hands.</h1><p>Review, evaluate, and move promising applications forward.</p></div></div><div className="panel"><div className="panel-head"><h3>{data?.total ?? '…'} incoming applications</h3><span className="tag">{data?.statusCounts?.submitted || 0} need review</span></div>
    <div className="role-pills" aria-label="Application status filters">{tabs.map(([value, label]) => <button type="button" key={label} className={status === value ? 'active' : ''} onClick={() => update({ status: value, page: '' })}>{label}{value && data?.statusCounts?.[value] != null ? ` (${data.statusCounts[value]})` : ''}</button>)}</div>
    <div className="field"><label htmlFor="application-search">Search applicant or pet</label><input id="application-search" type="search" value={query} onChange={event => update({ q: event.target.value, page: '' })} /></div>
    {error ? <AppError message={error} retry={() => setRetry(value => value + 1)} /> : !data ? <div className="empty">Loading applications…</div> : data.items.length === 0 ? <div className="empty">No applications match this view.</div> : <div className="table-wrap"><table><thead><tr><th>Applicant</th><th>Pet</th><th>Submitted</th><th>Stage</th><th></th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td><b>{item.applicant_name}</b><br /><span style={{ fontSize: 10, color: 'var(--muted)' }}>{item.city}{item.state ? `, ${item.state}` : ''}</span></td><td>{item.pet_name}</td><td>{new Date(item.submitted_at).toLocaleDateString()}</td><td><span className={`status ${statusView[item.status]?.className || ''}`}>{statusView[item.status]?.label || item.status}</span></td><td><Link className="btn small lime" to={`/shelter/applications/${item.id}`}>Review →</Link></td></tr>)}</tbody></table></div>}
    {data?.totalPages > 1 && <nav className="pet-pagination" aria-label="Application pages"><button className="btn light small" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Previous</button><span>Page {page} of {data.totalPages}</span><button className="btn light small" disabled={page >= data.totalPages} onClick={() => update({ page: String(page + 1) })}>Next</button></nav>}
  </div></div></div></main>;
}

export function ApplicationSidebar({ active }) {
  return <aside className="side"><Link className="brand side-brand" to="/"><span className="brand-mark">🐾</span><span>Paw<em>Pal</em></span></Link><div className="side-label">Shelter workspace</div><Link className={active === 'dashboard' ? 'active' : ''} to="/shelter">◈ <span>Dashboard</span></Link><Link to="/shelter/pets">🐾 <span>Manage pets</span></Link><Link className={active === 'applications' ? 'active' : ''} to="/shelter/applications">▣ <span>Applications</span></Link><Link className={active === 'adoptions' ? 'active' : ''} to="/shelter/adoptions">⌁ <span>Adoption records</span></Link></aside>;
}

export function ApplicationReviewPage({ onToast, ModalComponent }) {
  const { id } = useParams(), navigate = useNavigate();
  const [application, setApplication] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false), [rejectOpen, setRejectOpen] = useState(false), [rejectNote, setRejectNote] = useState('');
  useEffect(() => { let active = true; getApplication(id).then(data => { if (active) { setApplication(data.application); setError(''); } }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, [id, retry]);
  const mutate = async operation => { setBusy(true); try { await operation(); const result = await getApplication(id); setApplication(result.application); onToast('Application updated.'); return true; } catch (err) { onToast(err.message); return false; } finally { setBusy(false); } };
  const startReview = () => mutate(() => transitionApplication(id, { to: 'under_review' }));
  const advance = to => mutate(() => transitionApplication(id, { to }));
  const saveCheck = (check, result) => mutate(() => updateApplicationChecks(id, [{ checkType: check.check_type, result, notes: check.notes }]));
  const reject = () => { if (!rejectNote.trim()) return onToast('Add a note before rejecting this application.'); mutate(() => transitionApplication(id, { to: 'rejected', note: rejectNote })).then(success => { if (success) { setRejectOpen(false); setRejectNote(''); } }); };
  if (error) return <main className="view show"><div className="flow-wrap"><AppError message={error} retry={() => setRetry(value => value + 1)} /></div></main>;
  if (!application) return <main className="view show"><div className="empty">Loading application…</div></main>;
  const canReview = application.status === 'under_review';
  const checkStatus = result => ({ pending: '○ To do', passed: '✓ Complete', failed: '× Needs attention', not_applicable: '— Not applicable' })[result];
  return <main className="view show"><div className="flow-wrap"><div className="flow-title"><div className="eyebrow">Shelter / Application review</div><h1>{application.applicant_name} + {application.pet.name}.</h1><p>Read the story, complete the checks, and make the next right call.</p></div><div className="flow-card">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 15, alignItems: 'center', borderBottom: '1px solid var(--line)', paddingBottom: 20, marginBottom: 20 }}><div><h2 style={{ fontSize: 24, margin: 0 }}>{application.pet.name}</h2><p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 11 }}>Applicant: {application.applicant_name} · Submitted {new Date(application.submitted_at).toLocaleDateString()}</p></div><span className={`status ${statusView[application.status]?.className || ''}`}>{statusView[application.status]?.label || application.status}</span></div>
    <h3 style={{ fontSize: 14, margin: '0 0 15px' }}>Application summary</h3><div className="fact-grid"><div className="fact"><small>Home</small><b>{application.home_type.replaceAll('_', ' ')}</b></div><div className="fact"><small>Experience</small><b>{application.experience.replaceAll('_', ' ')}</b></div><div className="fact"><small>Alone time</small><b>{application.hours_alone_per_day} hours / day</b></div><div className="fact"><small>Household</small><b>{application.household_adults} adults{application.has_children ? ` · children, youngest ${application.youngest_child_age ?? 'not provided'}` : ''}</b></div><div className="fact"><small>Ownership</small><b>{application.ownership.replaceAll('_', ' ')}</b></div><div className="fact"><small>Other pets</small><b>{application.other_pets || 'None listed'}</b></div></div>
    <div className="panel" style={{ boxShadow: 'none', background: 'var(--mint)', marginTop: 20 }}><b style={{ fontSize: 12 }}>Applicant’s reason</b><p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, margin: '9px 0 0' }}>{application.reason}</p></div>
    <h3 style={{ fontSize: 14, margin: '25px 0 12px' }}>Shelter guidance</h3><div className="chip-row">{application.risk_flags.length ? application.risk_flags.map(flag => <span className={`tag ${flag.severity === 'high' ? 'coral' : 'lav'}`} key={flag.code} title={flag.message}>{flag.severity}: {flag.message}</span>) : <span className="tag">No risk flags</span>}</div>
    <h3 style={{ fontSize: 14, margin: '25px 0 12px' }}>Verification checklist</h3><div className="check-grid">{application.checks.map(check => <div key={check.check_type} className={`check-option ${check.result === 'passed' || check.result === 'not_applicable' ? 'selected' : ''}`}><button type="button" disabled={!canReview || busy || check.result === 'not_applicable'} onClick={() => saveCheck(check, check.result === 'passed' ? 'failed' : 'passed')} aria-label={`${checkLabels[check.check_type]}: ${check.result}. Toggle result`} style={{ border: 0, background: 'transparent', color: 'inherit', padding: 0, textAlign: 'left', cursor: canReview ? 'pointer' : 'default' }}><b>{checkLabels[check.check_type]}</b><br />{checkStatus(check.result)}{check.check_type === 'vet_reference' && <small> · Recommended</small>}</button>{canReview && check.result !== 'not_applicable' && <input aria-label={`${checkLabels[check.check_type]} notes`} placeholder="Add a note" value={check.notes || ''} onChange={event => setApplication(current => ({ ...current, checks: current.checks.map(item => item.check_type === check.check_type ? { ...item, notes: event.target.value } : item) }))} onBlur={() => saveCheck(check, check.result)} />}</div>)}</div>
    {application.events.length > 0 && <div className="panel" style={{ boxShadow: 'none', marginTop: 20 }}><h3>Application timeline</h3>{application.events.map(event => <div className="activity" key={event.id}><b>{statusView[event.to_status]?.label || event.to_status}</b><span>{new Date(event.created_at).toLocaleString()}{event.note ? ` · ${event.note}` : ''}</span></div>)}</div>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 25 }}>
      {application.status === 'submitted' && <button className="btn lime" type="button" disabled={busy} onClick={startReview}>Start review →</button>}
      {canReview && <><button className="btn light" type="button" disabled={busy} onClick={() => setRejectOpen(true)}>Reject application</button><button className="btn lime" type="button" disabled={busy} onClick={() => advance('approved')}>Approve application ↗</button></>}
      {application.status === 'approved' && <><button className="btn light" type="button" disabled={busy} onClick={() => setRejectOpen(true)}>Reject application</button><button className="btn lime" type="button" disabled={busy} onClick={() => advance('completed')}>Mark adoption complete</button></>}
      {['rejected', 'completed'].includes(application.status) && <Link className="btn light" to="/shelter/applications">Back to applications</Link>}
    </div>
  </div></div>
  {ModalComponent && <ModalComponent open={rejectOpen} title="Reject application" onClose={() => { setRejectOpen(false); setRejectNote(''); }}><p className="sub">Share a note explaining this decision.</p><label className="field">Decision note<textarea rows="4" value={rejectNote} onChange={event => setRejectNote(event.target.value)} /></label><div className="flow-controls"><button className="btn light" type="button" onClick={() => { setRejectOpen(false); setRejectNote(''); }}>Cancel</button><button className="btn lime" type="button" disabled={busy || !rejectNote.trim()} onClick={reject}>Confirm rejection</button></div></ModalComponent>}
  </main>;
}

export function AdoptionRecordsPage({ onToast }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0), [page, setPage] = useState(1);
  useEffect(() => { let active = true; getAdoptionRecords({ page, pageSize: 12 }).then(value => { if (active) { setData(value); setError(''); } }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, [page, retry]);
  const download = () => { window.location.assign('/api/shelter/adoption-records.csv'); onToast('Downloading the adoption report.'); };
  return <main className="view show"><div className="workspace"><ApplicationSidebar active="adoptions" /><div className="work-main"><div className="work-head"><div><div className="eyebrow">Shelter / Adoption management</div><h1>Happy endings, recorded.</h1><p>A living record of every pet who found their way home.</p></div><button className="btn light small" type="button" onClick={download}>Download report</button></div>
    <div className="metric-grid"><div className="metric"><span>Completed adoptions</span><b>{data?.total ?? '—'}</b><i>Recorded through PawPal</i></div><div className="metric"><span>Completed this year</span><b>{data?.stats?.completedThisYear ?? '—'}</b><i>This calendar year</i></div><div className="metric"><span>Avg. days to adopt</span><b>{data?.stats?.averageDays ?? '—'}</b><i>From submission to completion</i></div><div className="metric"><span>Follow-ups</span><b>—</b><i>Not tracked in this module</i></div></div>
    <div className="panel"><div className="panel-head"><h3>Completed adoptions</h3><div className="tag">{new Date().getFullYear()}</div></div>{error ? <AppError message={error} retry={() => setRetry(value => value + 1)} /> : !data ? <div className="empty">Loading adoption records…</div> : data.items.length === 0 ? <div className="empty">Completed adoptions will appear here.</div> : <div className="table-wrap"><table><thead><tr><th>Pet</th><th>Adopter</th><th>Completed</th><th>Location</th><th>Record</th></tr></thead><tbody>{data.items.map(row => <tr key={row.id}><td><div className="table-pet">{row.pet_name}</div></td><td>{row.applicant_name}</td><td>{new Date(row.completed_at).toLocaleDateString()}</td><td>{row.city}{row.state ? `, ${row.state}` : ''}</td><td><Link className="btn small light" to={`/shelter/applications/${row.id}`}>View</Link></td></tr>)}</tbody></table></div>}{data?.totalPages > 1 && <nav className="pet-pagination" aria-label="Adoption record pages"><button className="btn light small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page} of {data.totalPages}</span><button className="btn light small" disabled={page >= data.totalPages} onClick={() => setPage(value => value + 1)}>Next</button></nav>}</div>
  </div></div></main>;
}

export function ShelterDashboardPage() {
  const [summary, setSummary] = useState(null), [recent, setRecent] = useState([]);
  useEffect(() => { let active = true; Promise.all([getShelterSummary(), getShelterApplications({ page: 1, pageSize: 3 })]).then(([stats, applications]) => { if (active) { setSummary(stats); setRecent(applications.items); } }).catch(() => { if (active) { setSummary(null); setRecent([]); } }); return () => { active = false; }; }, []);
  return <main className="view show"><div className="workspace"><ApplicationSidebar active="dashboard" /><div className="work-main"><div className="work-head"><div><div className="eyebrow">Shelter / Dashboard</div><h1>Good morning, your shelter.</h1><p>Here’s what’s moving through your shelter today.</p></div><Link className="btn lime" to="/shelter/pets/new">+ Add a pet</Link></div>
    <div className="metric-grid"><div className="metric"><span>Active pets</span><b>{summary?.activePets ?? '—'}</b><i>Current listings</i></div><div className="metric"><span>Pending applications</span><b>{summary?.openApplications ?? '—'}</b><i>{summary?.submitted ?? '—'} need review</i></div><div className="metric"><span>Adoptions completed</span><b>{summary?.completed ?? '—'}</b><i>Recorded placements</i></div><div className="metric"><span>Profile views</span><b>—</b><i>Not tracked yet</i></div></div>
    <div className="dashboard-split"><div className="panel"><div className="panel-head"><h3>Recent applications</h3><Link to="/shelter/applications">View queue →</Link></div>{recent.length ? recent.map(item => <Link className="activity" key={item.id} to={`/shelter/applications/${item.id}`}><div className="shelter-avatar" style={{ width: 34, height: 34 }}>{item.applicant_name?.[0] || 'A'}</div><div><b>{item.applicant_name} · {item.pet_name}</b><span>{new Date(item.submitted_at).toLocaleDateString()}</span></div><span className={`status ${statusView[item.status]?.className || ''}`} style={{ marginLeft: 'auto' }}>{statusView[item.status]?.label || item.status}</span></Link>) : <div className="empty">{summary ? 'No applications yet.' : 'Loading applications…'}</div>}</div><div className="panel"><div className="panel-head"><h3>Adoption pulse</h3><span className="tag">Current totals</span></div><div style={{ font: "700 43px 'Playfair Display'", margin: '12px 0 2px' }}>{summary?.openApplications ?? '—'}</div><span style={{ fontSize: 11, color: 'var(--muted)' }}>open applications to review</span><div style={{ marginTop: 18 }}><Link className="btn light small" to="/shelter/adoptions">View adoption records →</Link></div></div></div>
  </div></div></main>;
}
