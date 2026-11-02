const BREEDS = {
  dog: {
    'Labrador Retriever': ['large', 'high'], 'Golden Retriever': ['large', 'high'], 'German Shepherd': ['large', 'high'],
    'French Bulldog': ['small', 'medium'], 'Poodle': ['medium', 'high'], 'Beagle': ['medium', 'high'],
    'Bulldog': ['medium', 'low'], 'Dachshund': ['small', 'medium'], 'Border Collie': ['medium', 'high'],
    'Corgi': ['small', 'high'], 'Chihuahua': ['small', 'medium'], 'Mixed breed': ['medium', 'medium'],
  },
  cat: {
    'Domestic Shorthair': ['small', 'medium'], 'Domestic Longhair': ['small', 'medium'], 'Maine Coon': ['large', 'medium'],
    'Siamese': ['small', 'high'], 'Persian': ['medium', 'low'], 'Ragdoll': ['large', 'low'],
    'Bengal': ['medium', 'high'], 'British Shorthair': ['medium', 'low'], 'Mixed breed': ['small', 'medium'],
  },
  rabbit: {
    'Netherland Dwarf': ['small', 'medium'], 'Holland Lop': ['small', 'low'], 'Mini Rex': ['small', 'medium'],
    'Lionhead': ['small', 'medium'], 'Flemish Giant': ['xlarge', 'low'], 'Dutch': ['small', 'medium'],
    'English Lop': ['large', 'low'], 'Mixed breed': ['medium', 'medium'],
  },
};

export function listKnownBreeds(species) {
  return Object.entries(BREEDS[species] || {}).map(([breed, [size, energy]]) => ({ breed, size, energy }));
}

export function suggestBreed(species, breed) {
  const normalized = String(breed || '').trim().toLowerCase();
  const found = Object.entries(BREEDS[species] || {}).find(([name]) => name.toLowerCase() === normalized);
  return found ? { breed: found[0], size: found[1][0], energy: found[1][1] } : null;
}
