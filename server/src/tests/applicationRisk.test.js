import { describe, expect, it } from 'vitest';
import { computeRiskFlags } from '../services/applicationRisk.js';

const baselineApplication = {
  hours_alone_per_day: 2, home_type: 'house_with_yard', ownership: 'own', household_adults: 2,
  has_children: false, experience: 'experienced', other_pets: '',
};
const baselinePet = {
  species: 'dog', age_group: 'adult', size: 'medium', energy_level: 'medium', special_needs: false,
  house_trained: true, good_with_children: 'yes', good_with_dogs: 'yes', good_with_cats: 'yes',
};
const codes = (application = {}, pet = {}) => computeRiskFlags({ ...baselineApplication, ...application }, { ...baselinePet, ...pet }).map(flag => flag.code);

describe('computeRiskFlags', () => {
  it('uses dog alone-time boundaries at six and eight hours', () => {
    expect(codes({ hours_alone_per_day: 5 })).not.toContain('dog_alone_6h');
    expect(computeRiskFlags({ ...baselineApplication, hours_alone_per_day: 6 }, baselinePet).find(f => f.code === 'dog_alone_6h')?.severity).toBe('medium');
    expect(computeRiskFlags({ ...baselineApplication, hours_alone_per_day: 8 }, baselinePet).find(f => f.code === 'dog_alone_8h')?.severity).toBe('high');
  });

  it('flags baby dogs and cats from four hours alone, but not rabbits', () => {
    expect(codes({ hours_alone_per_day: 3 }, { age_group: 'baby' })).not.toContain('baby_pet_alone_4h');
    expect(codes({ hours_alone_per_day: 4 }, { age_group: 'baby' })).toContain('baby_pet_alone_4h');
    expect(codes({ hours_alone_per_day: 4 }, { species: 'cat', age_group: 'baby' })).toContain('baby_pet_alone_4h');
    expect(codes({ hours_alone_per_day: 4 }, { species: 'rabbit', age_group: 'baby' })).not.toContain('baby_pet_alone_4h');
  });

  it('does not apply dog or cat alone-time guidance to a custom species', () => {
    const flags = computeRiskFlags({ ...baselineApplication, hours_alone_per_day: 8 }, { ...baselinePet, species: 'hamster', age_group: 'baby' });
    expect(flags.map(flag => flag.code)).not.toContain('dog_alone_8h');
    expect(flags.map(flag => flag.code)).not.toContain('baby_pet_alone_4h');
  });

  it('reminds renters in apartments or houses about landlord permission', () => {
    for (const home_type of ['apartment', 'house_no_yard', 'house_with_yard']) {
      expect(codes({ ownership: 'rent', home_type })).toContain('renter_permission');
    }
    expect(codes({ ownership: 'rent', home_type: 'farm_acreage' })).not.toContain('renter_permission');
  });

  it.each([
    ['high energy', { energy_level: 'high' }],
    ['large', { size: 'large' }],
    ['xlarge', { size: 'xlarge' }],
    ['special needs', { special_needs: true }],
    ['not house trained', { house_trained: false }],
  ])('flags first-time adopters for %s care needs', (_label, pet) => {
    expect(codes({ experience: 'first_time' }, pet)).toContain('first_time_high_needs');
  });

  it('escalates unknown child compatibility when the youngest child is under five', () => {
    expect(computeRiskFlags({ ...baselineApplication, has_children: true, youngest_child_age: 5 }, { ...baselinePet, good_with_children: 'unknown' }).find(f => f.code === 'children_not_assessed')?.severity).toBe('medium');
    expect(computeRiskFlags({ ...baselineApplication, has_children: true, youngest_child_age: 4 }, { ...baselinePet, good_with_children: 'unknown' }).find(f => f.code === 'children_not_assessed')?.severity).toBe('high');
    expect(computeRiskFlags({ ...baselineApplication, has_children: true, youngest_child_age: 4 }, { ...baselinePet, good_with_children: 'no' }).find(f => f.code === 'children_not_recommended')?.severity).toBe('high');
  });

  it('flags dog and cat compatibility when household pets are mentioned', () => {
    expect(codes({ other_pets: 'One dog' }, { good_with_dogs: 'no' })).toContain('other_dog_not_recommended');
    expect(codes({ other_pets: 'One dog' }, { good_with_dogs: 'unknown' })).toContain('other_dog_not_assessed');
    expect(codes({ other_pets: 'Two cats' }, { good_with_cats: 'no' })).toContain('other_cat_not_recommended');
    expect(codes({ other_pets: 'Two cats' }, { good_with_cats: 'unknown' })).toContain('other_cat_not_assessed');
  });

  it('flags apartment households with large or high-energy dogs', () => {
    expect(codes({ home_type: 'apartment' }, { size: 'xlarge' })).toContain('apartment_active_dog');
    expect(codes({ home_type: 'apartment' }, { energy_level: 'high' })).toContain('apartment_active_dog');
    expect(codes({ home_type: 'apartment' }, { species: 'cat', size: 'large', energy_level: 'high' })).not.toContain('apartment_active_dog');
  });

  it('flags a single-adult household with a special-needs pet without affecting decisions', () => {
    expect(computeRiskFlags({ ...baselineApplication, household_adults: 1 }, { ...baselinePet, special_needs: true })).toContainEqual(expect.objectContaining({ code: 'single_adult_special_needs', severity: 'medium' }));
  });

  it('returns no flag when no advisory rules apply', () => {
    expect(computeRiskFlags(baselineApplication, baselinePet)).toEqual([]);
  });
});
