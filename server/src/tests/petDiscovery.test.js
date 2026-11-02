import { describe, expect, it } from 'vitest';
import { browsePetsQuerySchema } from '../schemas/petDiscovery.js';
import { buildReadiness, computeVaccinationStatus, toAgeLabel } from '../services/petDiscovery.js';

describe('pet discovery domain helpers', () => {
  it('formats ages from the stored month count', () => {
    expect(toAgeLabel(10)).toBe('10 mo');
    expect(toAgeLabel(24)).toBe('2 yrs');
    expect(toAgeLabel(14)).toBe('1 yr 2 mo');
  });

  it('computes all vaccine date states against the current date', () => {
    const today = new Date('2026-11-01T12:00:00Z');
    expect(computeVaccinationStatus(null, today)).toBe('not_recorded');
    expect(computeVaccinationStatus({ next_due_on: '2026-10-31' }, today)).toBe('overdue');
    expect(computeVaccinationStatus({ next_due_on: '2026-12-01' }, today)).toBe('due_soon');
    expect(computeVaccinationStatus({ next_due_on: '2027-01-01' }, today)).toBe('up_to_date');
    expect(computeVaccinationStatus({ next_due_on: null }, today)).toBe('up_to_date');
  });

  it('uses existing core vaccine statuses to calculate dog readiness', () => {
    const pet = { species: 'dog', spayed_neutered: true, microchipped: false, house_trained: true };
    const readiness = buildReadiness(pet, [
      { isCore: true, status: 'up_to_date' },
      { isCore: true, status: 'due_soon' },
    ]);
    expect(readiness).toEqual([
      { label: 'Vaccinated', ready: true },
      { label: 'Spayed/Neutered', ready: true },
      { label: 'Microchipped', ready: false },
      { label: 'House-trained', ready: true },
    ]);
  });

  it('labels cat and rabbit house training as litter training', () => {
    for (const species of ['cat', 'rabbit']) {
      expect(buildReadiness({ species, house_trained: true }, []).at(-1)).toEqual({ label: 'Litter-trained', ready: true });
    }
  });

  it('validates browse filters and clamps page size to 24', () => {
    const result = browsePetsQuerySchema.safeParse({ species: 'DOG', city: ' Portland ', pageSize: '100' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ species: ['dog'], city: 'Portland', status: 'available', sort: 'newest', page: 1, pageSize: 24 });
    expect(browsePetsQuerySchema.safeParse({ status: 'removed' }).success).toBe(false);
    expect(browsePetsQuerySchema.safeParse({ size: 'giant' }).success).toBe(false);
  });

  it('normalizes dynamic species names and rejects empty or invalid names', () => {
    expect(browsePetsQuerySchema.parse({ species: '  Guinea   Pig ' }).species).toEqual(['guinea pig']);
    expect(browsePetsQuerySchema.parse({ species: ['HAMSTER', 'Parrot'] }).species).toEqual(['hamster', 'parrot']);
    expect(browsePetsQuerySchema.safeParse({ species: ' ' }).success).toBe(false);
    expect(browsePetsQuerySchema.safeParse({ species: 'cat/fox' }).success).toBe(false);
    expect(browsePetsQuerySchema.safeParse({ species: 'a'.repeat(41) }).success).toBe(false);
  });
});
