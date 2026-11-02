const raise = severity => severity === 'low' ? 'medium' : 'high';

export function computeRiskFlags(application, pet) {
  const flags = [];
  const add = (code, severity, message) => flags.push({ code, severity, message });
  const hours = Number(application.hours_alone_per_day ?? application.hoursAlonePerDay ?? 0);
  const ageGroup = pet.age_group ?? pet.ageGroup;
  const isDog = pet.species === 'dog';
  const isBabyCatOrDog = ageGroup === 'baby' && ['dog', 'cat'].includes(pet.species);
  const homeType = application.home_type ?? application.homeType;
  const ownership = application.ownership;
  const experience = application.experience;
  const size = pet.size;
  const energy = pet.energy_level ?? pet.energyLevel;
  const specialNeeds = pet.special_needs ?? pet.specialNeeds;
  const houseTrained = pet.house_trained ?? pet.houseTrained;
  const hasChildren = application.has_children ?? application.hasChildren;
  const youngestAge = application.youngest_child_age ?? application.youngestChildAge;
  const adults = Number(application.household_adults ?? application.householdAdults ?? 1);
  const goodChildren = pet.good_with_children ?? pet.goodWithChildren;
  const goodDogs = pet.good_with_dogs ?? pet.goodWithDogs;
  const goodCats = pet.good_with_cats ?? pet.goodWithCats;
  const otherPets = String(application.other_pets ?? application.otherPets ?? '').toLowerCase();

  if (isDog && hours >= 8) add('dog_alone_8h', 'high', 'Dogs should not be left alone for 8 or more hours a day.');
  else if (isDog && hours >= 6) add('dog_alone_6h', 'medium', 'Consider a plan for care when the dog is alone 6 or more hours a day.');
  if (isBabyCatOrDog && hours >= 4) add('baby_pet_alone_4h', 'medium', 'A baby pet needs frequent care when alone 4 or more hours a day.');
  if (ownership === 'rent' && ['apartment', 'house_no_yard', 'house_with_yard'].includes(homeType)) {
    add('renter_permission', 'medium', 'Confirm landlord permission before moving forward.');
  }

  if (experience === 'first_time' && (energy === 'high' || ['large', 'xlarge'].includes(size) || specialNeeds || !houseTrained)) {
    add('first_time_high_needs', 'medium', 'A first-time adopter may need extra support with this pet’s care needs.');
  }

  if (hasChildren && goodChildren === 'no') {
    add('children_not_recommended', 'high', 'This pet is not currently assessed as a good fit with children.');
  } else if (hasChildren && goodChildren === 'unknown') {
    add('children_not_assessed', youngestAge != null && Number(youngestAge) < 5 ? raise('medium') : 'medium', 'Compatibility with children has not yet been assessed.');
  }

  const mentionsDog = /\bdogs?\b/.test(otherPets);
  const mentionsCat = /\bcats?\b/.test(otherPets);
  if (mentionsDog && goodDogs === 'no') add('other_dog_not_recommended', 'high', 'This pet is not currently assessed as a good fit with other dogs.');
  else if (mentionsDog && goodDogs === 'unknown') add('other_dog_not_assessed', 'medium', 'Compatibility with other dogs has not yet been assessed.');
  if (mentionsCat && goodCats === 'no') add('other_cat_not_recommended', 'high', 'This pet is not currently assessed as a good fit with cats.');
  else if (mentionsCat && goodCats === 'unknown') add('other_cat_not_assessed', 'medium', 'Compatibility with cats has not yet been assessed.');

  if (homeType === 'apartment' && isDog && (['large', 'xlarge'].includes(size) || energy === 'high')) {
    add('apartment_active_dog', 'medium', 'Consider whether the apartment and exercise routine suit this dog.');
  }
  if (adults === 1 && specialNeeds) add('single_adult_special_needs', 'medium', 'A single-adult household may want an additional care support plan.');
  return flags;
}
