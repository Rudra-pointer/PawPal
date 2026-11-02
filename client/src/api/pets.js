import { api } from './http.js';

function queryString(values = {}) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null || raw === '') continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) params.append(key, String(value));
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}

export const listPets = filters => api(`/pets${queryString(filters)}`);
export const getPet = id => api(`/pets/${encodeURIComponent(id)}`);
export const getFilterMetadata = () => api('/meta/filters');
export const getSavedPets = (page = 1, pageSize = 50) => api(`/me/saved${queryString({ page, pageSize })}`);
export const savePet = id => api(`/me/saved/${encodeURIComponent(id)}`, { method: 'POST' });
export const unsavePet = id => api(`/me/saved/${encodeURIComponent(id)}`, { method: 'DELETE' });
