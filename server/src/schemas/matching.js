import { z } from 'zod';
import { speciesNameSchema } from './species.js';

export const matchAnswersSchema = z.object({
  activity: z.enum(['low', 'medium', 'high']),
  home: z.enum(['apartment', 'house', 'farm']),
  kids: z.enum(['yes', 'no']),
  otherPets: z.enum(['none', 'dog', 'cat']),
  experience: z.enum(['first', 'some', 'expert']),
  species: z.union([speciesNameSchema, z.literal('any')]),
  age: z.enum(['baby', 'young', 'adult', 'senior', 'any']),
  size: z.enum(['small', 'medium', 'large', 'any']),
  includePairs: z.boolean().default(false),
}).strict();

export function parseMatchAnswers(value) {
  const parsed = matchAnswersSchema.safeParse(value);
  return parsed.success ? { data: parsed.data } : { error: parsed.error.issues };
}
