export const MATCH_WEIGHTS = Object.freeze({
  activity: 30,
  household: 25,
  home: 20,
  experience: 15,
  age: 5,
  size: 5,
});

const ACTIVITY = Object.freeze({ low: 0, medium: 1, high: 2 });
const AGE = Object.freeze({ baby: 0, young: 1, adult: 2, senior: 3 });
const SIZE = Object.freeze({ small: 0, medium: 1, large: 2, xlarge: 3 });
const HOME_FIT = Object.freeze({
  dog: {
    apartment: { small: 1, medium: 0.6, large: 0.2, xlarge: 0.1 },
    house: { small: 0.8, medium: 1, large: 0.9, xlarge: 0.8 },
    farm: { small: 0.7, medium: 0.9, large: 1, xlarge: 1 },
  },
  cat: { apartment: 1, house: 1, farm: 0.9 },
  rabbit: { apartment: 0.9, house: 1, farm: 0.8 },
});

const clamp = value => Math.max(0, Math.min(1, value));
const petValue = (pet, camel, snake) => pet[camel] ?? pet[snake];
const householdValue = value => value === 'yes' ? 1 : value === 'unknown' ? 0.5 : 0;
const preferenceFit = (preference, value, order) => {
  if (preference === 'any') return 1;
  const left = order[preference], right = order[value];
  if (left === undefined || right === undefined) return 0;
  const distance = Math.abs(left - right);
  return distance === 0 ? 1 : distance === 1 ? 0.5 : 0;
};

function getHouseholdFit(pet, answers) {
  const values = [];
  if (answers.kids === 'yes') values.push(householdValue(petValue(pet, 'goodWithChildren', 'good_with_children')));
  if (answers.otherPets === 'dog') values.push(householdValue(petValue(pet, 'goodWithDogs', 'good_with_dogs')));
  if (answers.otherPets === 'cat') values.push(householdValue(petValue(pet, 'goodWithCats', 'good_with_cats')));
  return values.length ? Math.min(...values) : 1;
}

function getHomeFit(pet, answers) {
  const species = petValue(pet, 'species', 'species');
  const home = answers.home;
  const size = petValue(pet, 'size', 'size');
  if (species === 'dog') return HOME_FIT.dog[home]?.[size] ?? 0;
  return HOME_FIT[species]?.[home] ?? (['dog', 'cat', 'rabbit'].includes(species) ? 0 : null);
}

function getExperienceFit(pet, answers) {
  const energy = petValue(pet, 'energyLevel', 'energy_level');
  const size = petValue(pet, 'size', 'size');
  const houseTrained = petValue(pet, 'houseTrained', 'house_trained');
  const specialNeeds = petValue(pet, 'specialNeeds', 'special_needs');
  const difficulty = (specialNeeds ? 2 : 0)
    + (energy === 'high' ? 1 : 0)
    + (size === 'large' || size === 'xlarge' ? 1 : 0)
    + (!houseTrained ? 1 : 0)
    + (petValue(pet, 'species', 'species') === 'rabbit' ? 1 : 0);
  const tolerance = { first: 1, some: 2, expert: 4 }[answers.experience];
  return clamp(1 - 0.5 * Math.max(0, difficulty - tolerance));
}

export function getMatchFits(pet, answers) {
  const energy = petValue(pet, 'energyLevel', 'energy_level');
  return {
    activity: 1 - Math.abs(ACTIVITY[answers.activity] - ACTIVITY[energy]) / 2,
    household: getHouseholdFit(pet, answers),
    home: getHomeFit(pet, answers),
    experience: getExperienceFit(pet, answers),
    age: preferenceFit(answers.age, petValue(pet, 'ageGroup', 'age_group'), AGE),
    size: preferenceFit(answers.size, petValue(pet, 'size', 'size'), SIZE),
  };
}

function reasonsFor(fits, pet, answers) {
  const reasons = [];
  if (fits.activity >= 0.8) reasons.push('Energy match');
  if (fits.household >= 0.8 && answers.kids === 'yes') reasons.push('Great with kids');
  if (fits.household >= 0.8 && answers.otherPets !== 'none') reasons.push('Good with your pet');
  if (fits.home !== null && fits.home >= 0.8) reasons.push('Fits your home');
  if (fits.experience >= 0.8) reasons.push('Experience fit');
  if (fits.age >= 0.8 && answers.age !== 'any') reasons.push('Age preference');
  if (fits.size >= 0.8 && answers.size !== 'any') reasons.push('Size preference');
  if (!reasons.length && fits.activity >= 0.8) reasons.push('A comfortable energy fit');
  return reasons;
}

function cautionsFor(fits, pet, answers) {
  const cautions = [];
  if (fits.activity <= 0.4) cautions.push('Needs more exercise than you described');
  if (fits.household <= 0.4) cautions.push('May need a slower introduction to your household');
  if (fits.home !== null && fits.home <= 0.4) cautions.push(answers.home === 'apartment' ? 'May find an apartment limiting' : 'May need more room at home');
  if (fits.experience <= 0.4) cautions.push('May need a more experienced adopter');
  if (fits.age <= 0.4 && answers.age !== 'any') cautions.push('Outside your preferred age group');
  if (fits.size <= 0.4 && answers.size !== 'any') cautions.push('Outside your preferred size');
  return cautions;
}

export function rankPets(pets, answers, limit = 12) {
  const species = answers.species === 'any' ? null : answers.species;
  const eligible = pets.filter(pet => petValue(pet, 'status', 'status') === 'available'
    && pet.shelterActive !== false
    && (!species || petValue(pet, 'species', 'species') === species));
  const hiddenPetsCount = answers.kids === 'yes'
    ? eligible.filter(pet => petValue(pet, 'goodWithChildren', 'good_with_children') === 'no').length
    : 0;
  const safePets = eligible.filter(pet => !(answers.kids === 'yes'
    && petValue(pet, 'goodWithChildren', 'good_with_children') === 'no'));
  const ranked = safePets.map((pet, index) => {
    const fits = getMatchFits(pet, answers);
    const assessedWeights = Object.entries(MATCH_WEIGHTS).filter(([factor]) => fits[factor] !== null);
    const totalWeight = assessedWeights.reduce((sum, [, weight]) => sum + weight, 0);
    const score = Math.round(assessedWeights
      .reduce((sum, [factor, weight]) => sum + weight * fits[factor], 0) / totalWeight * 100);
    return {
      ...pet,
      score,
      fits,
      unassessed: Object.entries(fits).filter(([, value]) => value === null).map(([factor]) => factor),
      reasons: reasonsFor(fits, pet, answers),
      cautions: cautionsFor(fits, pet, answers),
      _index: index,
    };
  }).sort((left, right) => right.score - left.score
    || new Date(right.createdAt ?? right.created_at ?? 0) - new Date(left.createdAt ?? left.created_at ?? 0)
    || left._index - right._index);
  return { items: ranked.slice(0, limit).map(({ _index, ...pet }) => pet), hiddenPetsCount };
}

const AGE_GROUP_ORDER = ['baby', 'young', 'adult', 'senior'];
const SIZE_ORDER = ['small', 'medium', 'large', 'xlarge'];
const energyValue = value => ACTIVITY[value];
const petAge = pet => petValue(pet, 'ageGroup', 'age_group');
const petEnergy = pet => petValue(pet, 'energyLevel', 'energy_level');
const petSize = pet => petValue(pet, 'size', 'size');
const petSpecies = pet => petValue(pet, 'species', 'species');

export function canPairPets(first, second) {
  if (first.id === second.id || first.shelterId !== second.shelterId) return false;
  const firstSpecies = petSpecies(first), secondSpecies = petSpecies(second);
  if (firstSpecies === secondSpecies) return true;
  if (firstSpecies === 'dog' && secondSpecies === 'cat') {
    return petValue(first, 'goodWithCats', 'good_with_cats') === 'yes'
      && petValue(second, 'goodWithDogs', 'good_with_dogs') === 'yes';
  }
  if (firstSpecies === 'cat' && secondSpecies === 'dog') {
    return petValue(first, 'goodWithDogs', 'good_with_dogs') === 'yes'
      && petValue(second, 'goodWithCats', 'good_with_cats') === 'yes';
  }
  return false;
}

export function scorePair(first, second) {
  const energyFit = 1 - Math.abs(energyValue(petEnergy(first)) - energyValue(petEnergy(second))) / 2;
  const ageDistance = Math.abs(AGE_GROUP_ORDER.indexOf(petAge(first)) - AGE_GROUP_ORDER.indexOf(petAge(second)));
  const ageFit = 1 - Math.min(ageDistance, 3) / 3;
  const firstTemperament = petValue(first, 'temperament', 'temperament') ?? [];
  const secondTemperament = petValue(second, 'temperament', 'temperament') ?? [];
  const union = new Set([...firstTemperament, ...secondTemperament]);
  const shared = firstTemperament.filter(tag => secondTemperament.includes(tag)).length;
  const temperamentFit = union.size ? shared / union.size : 0;
  const sizeFit = 1 - Math.abs(SIZE_ORDER.indexOf(petSize(first)) - SIZE_ORDER.indexOf(petSize(second))) / 3;
  return Math.round(30 * energyFit + 25 * ageFit + 25 * temperamentFit + 20 * sizeFit);
}

export function buildPetPairs(matches, limit = 12) {
  const candidates = matches.slice(0, 30);
  const pairs = [];
  const seen = new Set();
  for (let firstIndex = 0; firstIndex < candidates.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex += 1) {
      const first = candidates[firstIndex], second = candidates[secondIndex];
      if (!canPairPets(first, second)) continue;
      const key = [first.id, second.id].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const bonded = first.bondedPetId === second.id || second.bondedPetId === first.id
        || first.bonded_pet_id === second.id || second.bonded_pet_id === first.id;
      const score = scorePair(first, second);
      if (!bonded && score < 70) continue;
      pairs.push({ pets: [first, second], score, bonded, label: bonded ? 'Bonded pair: adopt together' : null,
        _order: firstIndex * candidates.length + secondIndex });
    }
  }
  return pairs.sort((left, right) => Number(right.bonded) - Number(left.bonded)
    || right.score - left.score || left._order - right._order)
    .slice(0, limit).map(({ _order, ...pair }) => pair);
}
