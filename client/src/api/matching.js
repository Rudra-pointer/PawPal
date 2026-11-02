import { api } from './http.js';

export function findMatches(answers) {
  return api('/match', { method: 'POST', body: JSON.stringify(answers) });
}

export function findPetPairs(answers) {
  return api('/match/pairs', { method: 'POST', body: JSON.stringify(answers) });
}

export function getLastMatch() {
  return api('/match/last');
}
