import { z } from 'zod';

export const speciesNameSchema = z.preprocess(
  value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : value,
  z.string()
    .min(1, 'Enter a species name.')
    .max(40, 'Species names must be 40 characters or fewer.')
    .regex(/^[\p{L}]+(?:[ -][\p{L}]+)*$/u, 'Use letters, spaces, or hyphens in the species name.'),
);
