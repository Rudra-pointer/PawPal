import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { findMatches, findPetPairs, getLastMatch } from './api/matching.js';
import { getFilterMetadata } from './api/pets.js';
import { useScrollReveal } from './hooks/useScrollReveal.js';

const QUESTIONS = [
  { key: 'activity', title: 'What does your everyday rhythm look like?', options: [
    ['low', '🛋️', 'Slow mornings & cozy nights'], ['medium', '🚶', 'Daily walks and a little adventure'], ['high', '🏃', 'Trails, hikes, and go-go-go'],
  ] },
  { key: 'home', title: 'What kind of home are you bringing them into?', options: [
    ['apartment', '🏢', 'Apartment living'], ['house', '🏡', 'A home with a yard'], ['farm', '🌳', 'Lots of space to roam'],
  ] },
  { key: 'kids', title: 'Are there children at home?', options: [
    ['yes', '👨‍👩‍👧', 'Yes, children live in my home'], ['no', '🏠', 'No children live in my home'],
  ] },
  { key: 'otherPets', title: 'Do you share your home with another pet?', options: [
    ['none', '🏡', 'No other pets'], ['dog', '🐕', 'A dog'], ['cat', '🐈', 'A cat'],
  ] },
  { key: 'experience', title: 'How much pet experience do you have?', options: [
    ['first', '🌱', 'First-time adopter'], ['some', '🐾', 'I’ve had pets before'], ['expert', '🏆', 'I’m an experienced pet person'],
  ] },
  { key: 'species', title: 'Who are you hoping to meet?', options: [
    ['dog', '🐕', 'Dogs'], ['cat', '🐈', 'Cats'], ['rabbit', '🐇', 'Rabbits'], ['any', '✨', 'I’m open to any species'],
  ] },
  { key: 'preferences', title: 'Any age or size preferences?', preferences: true },
];

const INITIAL_ANSWERS = Object.freeze({
  age: 'any',
  size: 'any',
  includePairs: false,
});
const STORAGE_KEY = 'pawpal_match_results';

function readSavedResults() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); }
  catch { return null; }
}

function saveResults(value) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); }
  catch { /* Results remain available through route state for this navigation. */ }
}

export function MatchQuizPage({ onToast }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(INITIAL_ANSWERS);
  const [speciesOptions, setSpeciesOptions] = useState(QUESTIONS.find(question => question.key === 'species').options);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getFilterMetadata().then(metadata => {
      if (!active || !metadata.species?.length) return;
      const icons = { dog: '🐕', cat: '🐈', rabbit: '🐇' };
      const options = metadata.species.map(item => [item.species, icons[item.species] || '🐾', `${item.species.replace(/\b\w/g, letter => letter.toUpperCase())} · ${item.count} available`]);
      options.push(['any', '✨', 'I’m open to any species']);
      setSpeciesOptions(options);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const question = step === 5 ? { ...QUESTIONS[step], options: speciesOptions } : QUESTIONS[step];
  const selected = question.preferences ? true : answers[question.key] !== undefined;
  useScrollReveal([step]);

  const choose = value => setAnswers(current => ({ ...current, [question.key]: value }));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const matches = await findMatches(answers);
      const pairs = answers.includePairs ? await findPetPairs(answers) : { items: [], note: null };
      const result = { answers, matches, pairs };
      saveResults(result);
      navigate('/match/results', { state: result });
    } catch (requestError) {
      setError(requestError.message);
      onToast?.(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return <main className="view show"><section className="quiz"><div className="container quiz-card">
    <div className="eyebrow" style={{ justifyContent: 'center' }}>Adopter / Smart pet matching</div>
    <h1>Find your kind of wonderful.</h1>
    <p className="intro">Seven small questions help us understand the life you’re inviting a pet into. We’ll do the matching work.</p>
    <div className="quiz-progress" role="progressbar" aria-label="Quiz progress" aria-valuemin="1" aria-valuemax="7" aria-valuenow={step + 1}><i style={{ width: `${((step + 1) / QUESTIONS.length) * 100}%` }}/></div>
    <div style={{ textAlign: 'center', color: 'var(--muted)', font: "10px 'DM Mono'", marginBottom: 12 }}>QUESTION {step + 1} OF {QUESTIONS.length}</div>
    <section className="question" aria-labelledby="match-question-title">
      <h2 id="match-question-title">{question.title}</h2>
      <p>{question.preferences ? 'Choose what matters to you, or leave either preference open.' : 'Choose the answer that feels most like you.'}</p>
      {question.preferences ? <div className="check-grid">
        <label className="field">Age group
          <select className="quiz-option" value={answers.age} onChange={event => setAnswers(current => ({ ...current, age: event.target.value }))}>
            <option value="any">Any age</option><option value="baby">Baby</option><option value="young">Young</option><option value="adult">Adult</option><option value="senior">Senior</option>
          </select>
        </label>
        <label className="field">Size
          <select className="quiz-option" value={answers.size} onChange={event => setAnswers(current => ({ ...current, size: event.target.value }))}>
            <option value="any">Any size</option><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
          </select>
        </label>
      </div> : <div className="quiz-options">{question.options.map(([value, icon, label]) => <button key={value} type="button" className={`quiz-option ${answers[question.key] === value ? 'selected' : ''}`} aria-pressed={answers[question.key] === value} onClick={() => choose(value)}><span aria-hidden="true">{icon}</span>{label}</button>)}</div>}
      {question.preferences && <label className="quiz-option" style={{ marginTop: 12 }}><input type="checkbox" checked={answers.includePairs} onChange={event => setAnswers(current => ({ ...current, includePairs: event.target.checked }))}/> I’d love to adopt two pets</label>}
      {error && <p role="alert">{error}</p>}
      <div className="flow-controls">
        <button className="btn light" type="button" disabled={step === 0 || busy} onClick={() => setStep(value => value - 1)}>← Back</button>
        {step < QUESTIONS.length - 1
          ? <button className="btn lime" type="button" disabled={!selected || busy} onClick={() => setStep(value => value + 1)}>Next →</button>
          : <button className="btn lime" type="button" disabled={busy} onClick={submit}>{busy ? 'Finding your matches…' : 'See my matches ✦'}</button>}
      </div>
    </section>
  </div></section></main>;
}

function MatchResult({ pet }) {
  return <article className="result">
    <img src={pet.photo || '/pawpal-placeholder.svg'} alt={pet.name}/>
    <div>
      <h3>{pet.name}</h3>
      <p>{pet.species.replace(/\b\w/g, letter => letter.toUpperCase())} · {pet.breed} · {pet.ageGroup} · {pet.city}{pet.state ? `, ${pet.state}` : ''}</p>
      <div className="result-tags">{pet.reasons.map(reason => <span className="tag" key={reason}>{reason}</span>)}{pet.cautions.map(caution => <span className="tag lav" key={caution}>{caution}</span>)}{pet.unassessed?.includes('home')&&<span className="tag lav">Home compatibility not yet assessed for this species</span>}</div>
      <Link className="btn light small" to={`/pets/${pet.id}`}>Meet {pet.name} →</Link>
    </div>
    <div className="ring" style={{ '--score': `${pet.score}%` }} aria-label={`${pet.score}% compatibility`}><span>{pet.score}%</span></div>
  </article>;
}

function PairResult({ pair }) {
  return <article className="result">
    <div className="pair-photos" style={{ width: 100, display: 'flex', gap: 3 }}>
      {pair.pets.map(pet => <img key={pet.id} style={{ width: 48, height: 100, borderRadius: 12, objectFit: 'cover' }} src={pet.photo || '/pawpal-placeholder.svg'} alt={pet.name}/>)}</div>
    <div>
      {pair.label && <span className="status">{pair.label}</span>}
      <h3>{pair.pets.map(pet => pet.name).join(' & ')}</h3>
      <p>{pair.pets.map(pet => `${pet.breed} · ${pet.city}`).join(' + ')}</p>
      {!pair.label && <div className="result-tags"><span className="tag">Pair compatibility</span></div>}
    </div>
    <div className="ring" style={{ '--score': `${pair.score}%` }} aria-label={`${pair.score}% pair compatibility`}><span>{pair.score}%</span></div>
  </article>;
}

export function MatchResultsPage({ user, onToast }) {
  const location = useLocation();
  const [result, setResult] = useState(() => location.state || readSavedResults());
  const [error, setError] = useState('');
  const [species, setSpecies] = useState('all');
  const [loading, setLoading] = useState(!result && Boolean(user));
  useScrollReveal([result, species]);

  useEffect(() => {
    if (result || !user) return undefined;
    let active = true;
    getLastMatch().then(last => {
      if (active && last.item) {
        const restored = { answers: last.item.answers, matches: last.item.results, pairs: { items: [], note: null } };
        setResult(restored);
        saveResults(restored);
      }
    }).catch(requestError => {
      if (active) { setError(requestError.message); onToast?.(requestError.message); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [result, user, onToast]);

  const items = (result?.matches?.items || []).filter(pet => species === 'all' || pet.species === species);
  const speciesOptions = [...new Set((result?.matches?.items || []).map(pet => pet.species))].sort();
  const pairs = result?.pairs?.items || [];
  const rabbitResults = result?.answers?.species === 'rabbit'
    || (result?.matches?.items || []).some(pet => pet.species === 'rabbit')
    || pairs.some(pair => pair.pets.some(pet => pet.species === 'rabbit'));

  return <main className="view show"><section className="results"><div className="container">
    <div className="results-head"><div className="eyebrow" style={{ justifyContent: 'center' }}>Your smart match results</div><h1>These feel like your people.</h1><p style={{ color: 'var(--muted)', fontSize: 13 }}>Ranked by compatibility with your lifestyle and home.</p></div>
    {loading && <div className="empty" role="status">Loading your last match…</div>}
    {error && <div className="empty" role="alert">{error} <button className="btn light small" type="button" onClick={() => window.location.reload()}>Try again</button></div>}
    {!loading && !error && !result && <div className="empty"><p>Take the quiz to see pets matched to your home and lifestyle.</p><Link className="btn lime" to="/match">Start the match quiz →</Link></div>}
    {!loading && result && <>
      {rabbitResults && <p className="status">Rabbits are social animals and usually do best in pairs</p>}
      {result.matches?.hiddenPetsCount > 0 && <p className="status wait" role="status">{result.matches.hiddenPetsCount} {result.matches.hiddenPetsCount === 1 ? 'pet was' : 'pets were'} hidden because they are not suited to children.</p>}
      <div className="filter-panel" style={{ maxWidth: 760, margin: '0 auto 18px', padding: 12 }}><label htmlFor="match-species-filter">Species </label><select id="match-species-filter" value={species} onChange={event => setSpecies(event.target.value)}><option value="all">All matches</option>{speciesOptions.map(value=><option key={value} value={value}>{value.replace(/\b\w/g, letter => letter.toUpperCase())}</option>)}</select></div>
      <div className="result-list">{items.map(pet => <MatchResult key={pet.id} pet={pet}/>)}{items.length === 0 && <div className="empty">No pets match this species filter. Choose another species or retake the quiz.</div>}</div>
      {result.answers?.includePairs && <section className="result-list" aria-labelledby="pair-results-title"><div className="section-head"><div><div className="eyebrow">Two-pet households</div><h2 id="pair-results-title">Friends who fit together</h2></div></div>{pairs.length ? pairs.map((pair, index) => <PairResult key={`${pair.pets[0].id}-${pair.pets[1].id}-${index}`} pair={pair}/>) : <div className="empty">No compatible pair is available right now. You can still meet an individual match.</div>}</section>}
      <div style={{ textAlign: 'center', marginTop: 27 }}><Link className="btn light" to="/match" onClick={() => { try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Optional session storage. */ } }}>Retake quiz</Link></div>
    </>}
  </div></section></main>;
}
