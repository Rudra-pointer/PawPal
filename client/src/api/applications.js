import { api } from './http.js';

const params = values => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') query.set(key, value);
  return query.size ? `?${query}` : '';
};

export const submitApplication = data => api('/applications', { method: 'POST', body: JSON.stringify(data) });
export const getMyApplications = filters => api(`/applications/mine${params(filters)}`);
export const getShelterApplications = filters => api(`/applications/shelter${params(filters)}`);
export const getApplication = id => api(`/applications/${encodeURIComponent(id)}`);
export const transitionApplication = (id, data) => api(`/applications/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify(data) });
export const updateApplicationChecks = (id, checks) => api(`/applications/${encodeURIComponent(id)}/checks`, { method: 'PATCH', body: JSON.stringify({ checks }) });
export const getAdoptionRecords = filters => api(`/shelter/adoption-records${params(filters)}`);
export const getShelterSummary = () => api('/shelter/summary');
