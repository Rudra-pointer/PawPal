import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getFilterMetadata, getPet, getSavedPets, listPets, savePet, unsavePet } from './api/pets.js';
import { api } from './api/http.js';

export const formatSpeciesLabel = value => String(value || '')
  .replaceAll('-', ' ')
  .replace(/\b\w/g, character => character.toUpperCase());
const sizes = ['small', 'medium', 'large', 'xlarge'];
const ages = ['baby', 'young', 'adult', 'senior'];

export function PetCard({ pet, saved = false, onSave, loading = 'lazy' }) {
  return <article className="pet-card">
    <div className="pet-image"><Link to={`/pets/${pet.id}`} aria-label={`View ${pet.name}'s profile`}>
      {pet.primaryPhoto ? <img src={pet.primaryPhoto} alt={`${pet.name}, available for adoption`} width="800" height="600" loading={loading} /> : <span className="pet-placeholder" aria-hidden="true">🐾</span>}
    </Link><span className="pet-available">{pet.status === 'available' ? 'Available' : pet.status}</span>
      {onSave && <button className="heart" type="button" aria-label={saved ? `Remove ${pet.name} from saved pets` : `Save ${pet.name}`} aria-pressed={saved} onClick={() => onSave(pet)}>{saved ? '♥' : '♡'}</button>}
    </div>
    <div className="pet-body"><h3><Link to={`/pets/${pet.id}`}>{pet.name}</Link></h3>
      <div className="pet-meta">{pet.breed} · {pet.ageLabel}</div>
      <div className="pet-foot"><span>⌖ {pet.city}{pet.state ? `, ${pet.state}` : ''}</span><span className="tag">{pet.gender}</span></div>
    </div>
  </article>;
}

function ChoiceGroup({ title, values, selected, onToggle, labels = {} }) {
  return <div className="filter-group"><b style={{ fontSize: 12 }}>{title}</b>{values.map(value => <label key={value}>
    <input type="checkbox" checked={selected.includes(value)} disabled={selected.length === 1 && selected.includes(value)} onChange={() => onToggle(value)} /> {labels[value] || value[0].toUpperCase() + value.slice(1)}
  </label>)}</div>;
}

export function FilterPanel({ searchParams, setSearchParams, metadata }) {
  const species = metadata.species || [];
  const speciesValues = species.map(item => item.species);
  const speciesLabels = Object.fromEntries(species.map(item => [item.species,
    `${formatSpeciesLabel(item.species)} (${item.count})`]));
  const selected = key => searchParams.getAll(key);
  const toggle = (key, value) => {
    const params = new URLSearchParams(searchParams);
    const defaults = key === 'species' ? speciesValues : key === 'size' ? sizes.slice(0, 3) : key === 'ageGroup' ? ages : [];
    const values = params.getAll(key).length ? params.getAll(key) : defaults;
    params.delete(key);
    (values.includes(value) ? values.filter(item => item !== value) : [...values, value]).forEach(item => params.append(key, item));
    params.delete('page');
    setSearchParams(params);
  };
  const reset = () => setSearchParams({});
  return <aside className="filter-panel"><h3>Filter the feeling <button type="button" onClick={reset}>Reset all</button></h3>
    <ChoiceGroup title="Species" values={speciesValues} labels={speciesLabels} selected={selected('species').length ? selected('species') : speciesValues} onToggle={value => toggle('species', value)} />
    <ChoiceGroup title="Size" values={sizes} selected={selected('size').length ? selected('size') : sizes.slice(0, 3)} onToggle={value => toggle('size', value)} />
    <ChoiceGroup title="Age" values={ages} selected={selected('ageGroup').length ? selected('ageGroup') : ages} onToggle={value => toggle('ageGroup', value)} />
    <div className="filter-group"><label htmlFor="pet-city">Location</label><select id="pet-city" value={searchParams.get('city') || ''} onChange={event => { const next = new URLSearchParams(searchParams); event.target.value ? next.set('city', event.target.value) : next.delete('city'); next.delete('page'); setSearchParams(next); }}><option value="">Anywhere</option>{metadata.cities?.map(city => <option key={`${city.city}-${city.state}`} value={city.city}>{city.city}, {city.state}</option>)}</select></div>
    <div className="filter-group"><label htmlFor="pet-breed">Breed</label><select id="pet-breed" value={searchParams.get('breed') || ''} onChange={event => { const next = new URLSearchParams(searchParams); event.target.value ? next.set('breed', event.target.value) : next.delete('breed'); next.delete('page'); setSearchParams(next); }}><option value="">Any breed</option>{metadata.breeds?.map(breed => <option key={`${breed.species}-${breed.breed}`} value={breed.breed}>{breed.breed} ({breed.count})</option>)}</select></div>
    <div className="filter-group"><label htmlFor="pet-status">Availability</label><select id="pet-status" value={searchParams.get('status') || 'available'} onChange={event => { const next = new URLSearchParams(searchParams); event.target.value === 'available' ? next.delete('status') : next.set('status', event.target.value); next.delete('page'); setSearchParams(next); }}><option value="available">Available</option><option value="pending">Pending</option><option value="adopted">Adopted</option></select></div>
    <div className="filter-group"><label htmlFor="pet-gender">Gender</label><select id="pet-gender" value={searchParams.get('gender') || ''} onChange={event => { const next = new URLSearchParams(searchParams); event.target.value ? next.set('gender', event.target.value) : next.delete('gender'); next.delete('page'); setSearchParams(next); }}><option value="">Any</option><option value="female">Female</option><option value="male">Male</option><option value="unknown">Unknown</option></select></div>
    <div className="filter-group"><label htmlFor="pet-energy">Energy</label><select id="pet-energy" value={searchParams.get('energy') || ''} onChange={event => { const next = new URLSearchParams(searchParams); event.target.value ? next.set('energy', event.target.value) : next.delete('energy'); next.delete('page'); setSearchParams(next); }}><option value="">Any</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
  </aside>;
}

export function BrowsePage({ onToast, user }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [metadata, setMetadata] = useState({ species: [], cities: [] });
  const [result, setResult] = useState({ items: [], total: 0, page: 1, totalPages: 0 });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [saved, setSaved] = useState(new Set()), [search, setSearch] = useState(searchParams.get('q') || '');
  const paramsKey = searchParams.toString();
  const query = useMemo(() => { const params = new URLSearchParams(paramsKey), values = {}; for (const key of new Set(params.keys())) { const list = params.getAll(key); values[key] = list.length > 1 ? list : list[0]; } return values; }, [paramsKey]);
  useEffect(() => { getFilterMetadata().then(setMetadata).catch(() => setMetadata({ species: [], cities: [] })); }, []);
  useEffect(() => { if (user?.role !== 'adopter') { setSaved(new Set()); return; } getSavedPets(1, 50).then(data => setSaved(new Set(data.items.map(item => item.id)))).catch(() => {}); }, [user]);
  useEffect(() => { const timer = setTimeout(() => { setSearchParams(current => { const next = new URLSearchParams(current); search.trim() ? next.set('q', search.trim()) : next.delete('q'); next.delete('page'); return next.toString() === current.toString() ? current : next; }); }, 300); return () => clearTimeout(timer); }, [search, setSearchParams]);
  useEffect(() => { setSearch(searchParams.get('q') || ''); }, [searchParams.get('q')]);
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => { let active = true; setLoading(true); setError(''); listPets(query).then(data => { if (active) setResult(data); }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [paramsKey, retryCount]);
  const navigate = useNavigate();
  const toggleSaved = async pet => { if (!user) { const next = `/browse${paramsKey ? `?${paramsKey}` : ''}`; navigate(`/login?next=${encodeURIComponent(next)}`); return; } if (user.role !== 'adopter') { onToast('Only adopter accounts can save pets.'); return; } try { if (saved.has(pet.id)) { await unsavePet(pet.id); setSaved(current => { const next = new Set(current); next.delete(pet.id); return next; }); onToast(`${pet.name} removed from saved pets.`); } else { await savePet(pet.id); setSaved(current => new Set(current).add(pet.id)); onToast(`${pet.name} saved for later.`); } } catch (err) { onToast(err.message); } };
  const changePage = page => { const next = new URLSearchParams(searchParams); page > 1 ? next.set('page', page) : next.delete('page'); setSearchParams(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  return <main className="view show"><section className="page-hero"><div className="container"><div className="eyebrow">Public / Browse pets</div><h1>Good pets.<br />Great possibilities.</h1><p>{result.total} pets are looking for a home that feels like theirs.</p></div><div className="shape">✦</div></section><div className="container browse-wrap"><FilterPanel searchParams={searchParams} setSearchParams={setSearchParams} metadata={metadata} /><section aria-label="Pet search results"><div className="browse-top"><p><b>{result.total}</b> pets match your filters</p><div><input className="browse-search" aria-label="Search pets" placeholder="Search by name, breed, or story" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="Sort pets" value={searchParams.get('sort') || 'newest'} onChange={event => { const next = new URLSearchParams(searchParams); next.set('sort', event.target.value); next.delete('page'); setSearchParams(next); }}><option value="newest">Recommended first</option><option value="name">Name A–Z</option><option value="age_asc">Youngest first</option><option value="age_desc">Oldest first</option></select></div></div>
    {error ? <div className="empty"><h2>We couldn’t load pets.</h2><p>{error}</p><button className="btn light small" onClick={() => setRetryCount(value => value + 1)}>Try again</button></div> : loading ? <div className="browse-grid" aria-label="Loading pets">{Array.from({ length: 6 }, (_, index) => <div className="pet-card pet-skeleton" key={index} aria-hidden="true" />)}</div> : result.items.length ? <><div className="browse-grid">{result.items.map((pet, index) => <PetCard key={pet.id} pet={pet} saved={saved.has(pet.id)} onSave={toggleSaved} loading={index < 4 ? 'eager' : 'lazy'} />)}</div>{result.totalPages > 1 && <nav className="pet-pagination" aria-label="Pet result pages"><button className="btn light small" disabled={result.page <= 1} onClick={() => changePage(result.page - 1)}>Previous</button><span>Page {result.page} of {result.totalPages}</span><button className="btn light small" disabled={result.page >= result.totalPages} onClick={() => changePage(result.page + 1)}>Next</button></nav>}</> : <div className="empty"><h2>No pets match those filters just yet.</h2><p>Try broadening your search to meet more wonderful pets.</p><button className="btn light small" onClick={() => setSearchParams({})}>Reset all filters</button></div>}
  </section></div></main>;
}

const triState = value => value === 'yes' ? 'Yes' : value === 'no' ? 'No' : 'Not yet assessed';
const statusLabel = value => ({ up_to_date: 'Up to date', due_soon: 'Due soon', overdue: 'Overdue', not_recorded: 'Not recorded' }[value] || value);
export function PetProfilePage({ id, onToast, user, ModalComponent }) {
  const navigate = useNavigate(); const [pet, setPet] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [photo, setPhoto] = useState(''), [saved, setSaved] = useState(false), [reportOpen,setReportOpen]=useState(false),[reportReason,setReportReason]=useState('inaccurate_information'),[reportDetails,setReportDetails]=useState(''),[reportBusy,setReportBusy]=useState(false);
  useEffect(() => { let active = true; setLoading(true); setError(''); getPet(id).then(data => { if (active) { setPet(data); setPhoto(data.primaryPhoto || ''); } }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [id]);
  useEffect(() => { if (user?.role !== 'adopter' || !id) { setSaved(false); return; } getSavedPets(1, 50).then(data => setSaved(data.items.some(item => item.id === id))).catch(() => {}); }, [id, user]);
  const toggleSaved = async () => { if (!user) { navigate(`/login?next=${encodeURIComponent(`/pets/${id}`)}`); return; } if (user.role !== 'adopter') { onToast('Only adopter accounts can save pets.'); return; } try { if (saved) { await unsavePet(id); setSaved(false); onToast(`${pet.name} removed from saved pets.`); } else { await savePet(id); setSaved(true); onToast(`${pet.name} saved for later.`); } } catch (err) { onToast(err.message); } };
  const submitReport=async()=>{if(!user){navigate(`/login?next=${encodeURIComponent(`/pets/${id}`)}`);return}if(!['adopter','shelter'].includes(user.role)){onToast('Only adopters and shelters can report a listing.');return}setReportBusy(true);try{await api('/reports',{method:'POST',body:JSON.stringify({targetType:'pet',targetId:id,reason:reportReason,details:reportDetails})});setReportOpen(false);setReportDetails('');onToast('Thank you. Your report was sent for review.')}catch(err){onToast(err.message)}finally{setReportBusy(false)}};
  if (loading) return <main className="view show"><section className="profile"><div className="container empty">Loading pet profile…</div></section></main>;
  if (error || !pet) return <main className="view show"><section className="profile"><div className="container empty"><h1>Pet profile unavailable</h1><p>{error || 'This pet could not be found.'}</p><Link className="btn light" to="/browse">Browse pets</Link></div></section></main>;
  const profileFacts = [['Species', formatSpeciesLabel(pet.species)], ['Size', pet.size], ['Energy', pet.energyLevel], ['Good with', `Kids: ${triState(pet.goodWith.children)}`]];
  const available = pet.status === 'available';
  return <main className="view show">
    <section className="profile"><div className="container profile-grid">
      <div>
        <div className="profile-photo-frame">
          {photo ? <img className="profile-photo" src={photo} alt={`${pet.name}, ${formatSpeciesLabel(pet.species)} available for adoption`} loading="eager" /> : <div className="profile-photo pet-placeholder" aria-label={`No photo available for ${pet.name}`}>🐾</div>}
        </div>
        {pet.photos.length > 1 && <div className="profile-thumbnails" aria-label={`${pet.name} photo gallery`}>
          {pet.photos.map((item, index) => <button key={item.id} type="button" className={photo === item.url ? 'active' : ''} aria-label={`Show ${pet.name} photo ${index + 1}`} aria-pressed={photo === item.url} onClick={() => setPhoto(item.url)}><img src={item.url} alt="" loading="lazy" /></button>)}
        </div>}
      </div>
      <div>
        <div className="eyebrow">Pet profile / {pet.shelter.verified ? 'verified' : 'pending verification'}</div>
        <h1>{pet.name}.</h1>
        <p className="profile-lead">{formatSpeciesLabel(pet.species)} · {pet.breed} · {pet.ageLabel} · {pet.shelter.city}, {pet.shelter.state}<br /><br />{pet.description}</p>
        <div className="fact-grid">{profileFacts.map(([label, value]) => <div className="fact" key={label}><small>{label}</small><b>{label === 'Good with' ? `Children: ${triState(pet.goodWith.children)}` : value}</b></div>)}</div>
        <div className="chip-row">{pet.readiness.map(item => <span className={`tag${item.ready ? '' : ' coral'}`} key={item.label}>{item.ready ? item.label : `${item.label} not recorded`}</span>)}{pet.temperament.map(item => <span className="tag coral" key={item}>{formatSpeciesLabel(item)}</span>)}</div>
        {pet.bondedPet && <div className="bond-banner">Bonded with {pet.bondedPet.name} — they are looking for a home together.</div>}
        <div className="shelter-note"><div className="shelter-avatar" aria-hidden="true">⌂</div><div><b style={{ fontSize: 13 }}>{pet.shelter.name}</b><div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{pet.shelter.verified ? 'Verified partner' : 'Verification pending'} · {pet.shelter.city}, {pet.shelter.state}</div></div></div>
        <div className="hero-actions">
          {available ? <button className="btn lime" type="button" onClick={() => navigate(`/apply/${pet.id}`)}>Apply to adopt {pet.name} →</button> : <span className="status">{pet.status === 'pending' ? 'An application is in progress' : 'Adopted'}</span>}
          <button className="btn light" type="button" aria-pressed={saved} onClick={toggleSaved}>{saved ? '♥ Saved' : '♡ Save pet'}</button>
          <Link className="btn light" to="/browse">← Keep browsing</Link>
          <button className="btn light small" type="button" onClick={() => setReportOpen(true)}>Report listing</button>
        </div>
      </div>
    </div></section>
    <section className="section tint"><div className="container">
      <div className="section-head"><div><div className="eyebrow">Health & readiness</div><h2>Care details</h2></div></div>
      <div className="profile-health"><h3>Vaccination timeline</h3>{pet.vaccinations.length ? pet.vaccinations.map(vaccine => <div className="vaccine-row" key={vaccine.id}><b>{vaccine.name}{vaccine.isCore ? ' · Core' : ''}</b><span>{statusLabel(vaccine.status)}</span></div>) : <p>No vaccine records have been added yet.</p>}</div>
      <div className="section-head"><div><div className="eyebrow">Similar energy</div><h2>You might also like</h2></div></div>
      {pet.similarPets.length ? <div className="pet-grid">{pet.similarPets.map(item => <PetCard key={item.id} pet={item} />)}</div> : <div className="empty"><p>There are no similar available pets to show right now.</p></div>}
    </div></section>
    {ModalComponent && <ModalComponent open={reportOpen} title={`Report ${pet.name}'s listing`} onClose={() => { setReportOpen(false); setReportDetails(''); }}><div className="field"><label htmlFor="report-reason">Reason</label><select id="report-reason" value={reportReason} onChange={event => setReportReason(event.target.value)}><option value="inaccurate_information">Inaccurate information</option><option value="animal_welfare_concern">Welfare concern</option><option value="duplicate_listing">Duplicate listing</option><option value="inappropriate_content">Inappropriate content</option><option value="suspected_scam">Suspected scam</option><option value="other">Other</option></select></div><div className="field"><label htmlFor="report-details">Details</label><textarea id="report-details" rows="4" maxLength="1000" value={reportDetails} onChange={event => setReportDetails(event.target.value)} /></div><div className="hero-actions"><button className="btn light" type="button" onClick={() => { setReportOpen(false); setReportDetails(''); }}>Cancel</button><button className="btn lime" type="button" disabled={reportBusy} onClick={submitReport}>{reportBusy ? 'Sending…' : 'Send report'}</button></div></ModalComponent>}
  </main>;
}

export function FeaturedPets({ onToast, user }) {
  const navigate = useNavigate();
  const [pets, setPets] = useState([]), [total, setTotal] = useState(0), [saved, setSaved] = useState(new Set()), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retryCount, setRetryCount] = useState(0);
  useEffect(() => { let active = true; setLoading(true); setError(''); listPets({ pageSize: 6, sort: 'newest' }).then(data => { if (active) { setPets(data.items); setTotal(data.total); } }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [retryCount]);
  useEffect(() => { if (user?.role === 'adopter') getSavedPets(1, 50).then(data => setSaved(new Set(data.items.map(item => item.id)))).catch(() => {}); }, [user]);
  const toggle = async pet => { if (!user) { navigate(`/login?next=${encodeURIComponent('/')}`); return; } if (user.role !== 'adopter') { onToast('Only adopter accounts can save pets.'); return; } try { saved.has(pet.id) ? await unsavePet(pet.id) : await savePet(pet.id); setSaved(current => { const next = new Set(current); next.has(pet.id) ? next.delete(pet.id) : next.add(pet.id); return next; }); onToast(saved.has(pet.id) ? `${pet.name} removed from saved pets.` : `${pet.name} saved for later.`); } catch (error) { onToast(error.message); } };
  return <><p className="live-pet-count" aria-live="polite">{total} pets currently looking for a home</p>{error ? <div className="empty"><p>Featured pets are unavailable right now.</p><button className="btn light small" onClick={() => setRetryCount(value => value + 1)}>Try again</button></div> : loading ? <div className="pet-grid" aria-label="Loading featured pets">{Array.from({ length: 6 }, (_, index) => <div className="pet-card pet-skeleton" key={index} aria-hidden="true" />)}</div> : pets.length ? <div className="pet-grid">{pets.map(pet => <PetCard key={pet.id} pet={pet} saved={saved.has(pet.id)} onSave={toggle} />)}</div> : <div className="empty"><p>No pets are listed yet. Check back soon for new faces.</p></div>}</>;
}

export function DashboardSavedMetric() {
  const [total, setTotal] = useState(null);
  useEffect(() => { getSavedPets(1, 1).then(data => setTotal(data.total)).catch(() => setTotal(null)); }, []);
  return <div className="metric"><span>Saved pets</span><b>{total === null ? '—' : String(total).padStart(2, '0')}</b><i>Saved for later</i></div>;
}

export function SavedPetsSection({ onToast }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [page, setPage] = useState(1), [retryCount, setRetryCount] = useState(0);
  const reload = useCallback(targetPage => getSavedPets(targetPage, 12).then(value => { setData(value); setError(''); }).catch(err => setError(err.message)), []);
  useEffect(() => { reload(page); }, [reload, page, retryCount]);
  useEffect(() => { if (data?.totalPages && page > data.totalPages) setPage(data.totalPages); }, [data, page]);
  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div><div className="eyebrow">Your shortlist</div><h2>Saved pets</h2></div>
          <p>{data ? `${data.total} saved pets` : 'Loading your saved pets…'}</p>
        </div>
        {error && <div className="empty"><p>{error}</p><button className="btn light small" onClick={() => setRetryCount(value => value + 1)}>Try again</button></div>}
        {!error && data?.items.length > 0 && <>
          <div className="pet-grid">
            {data.items.map(pet => <PetCard key={pet.id} pet={pet} saved onSave={async item => {
              try { await unsavePet(item.id); onToast(`${item.name} removed from saved pets.`); reload(page); }
              catch (err) { onToast(err.message); }
            }} />)}
          </div>
          {data.totalPages > 1 && <nav className="pet-pagination" aria-label="Saved pet pages">
            <button className="btn light small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button>
            <span>Page {page} of {data.totalPages}</span>
            <button className="btn light small" disabled={page >= data.totalPages} onClick={() => setPage(value => value + 1)}>Next</button>
          </nav>}
        </>}
        {!error && data && data.items.length === 0 && <p>You haven’t saved a pet yet. <Link to="/browse">Find your match →</Link></p>}
      </div>
    </section>
  );
}
