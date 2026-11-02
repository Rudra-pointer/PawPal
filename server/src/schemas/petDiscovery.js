import { z } from 'zod';
import { speciesNameSchema } from './species.js';

const optionalText = max => z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().max(max).optional(),
);
const enumParam = values => z.preprocess(
  value => typeof value === 'string' ? value.trim().toLowerCase() : value,
  z.enum(values).optional(),
);
const enumArrayParam = values => z.preprocess(
  value => {
    if (value === undefined || value === null || value === '') return undefined;
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list.map(item => typeof item === 'string' ? item.trim().toLowerCase() : item);
  },
  z.array(z.enum(values)).min(1).max(values.length).optional(),
);
const speciesArrayParam = z.preprocess(
  value => {
    if (value === undefined || value === null || value === '') return undefined;
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list.map(item => item);
  },
  z.array(speciesNameSchema).min(1).max(20).optional(),
);

export const browsePetsQuerySchema = z.object({
  species: speciesArrayParam,
  breed: optionalText(80),
  ageGroup: enumArrayParam(['baby', 'young', 'adult', 'senior']),
  gender: enumParam(['male', 'female', 'unknown']),
  size: enumArrayParam(['small', 'medium', 'large', 'xlarge']),
  city: optionalText(80),
  status: z.preprocess(
    value => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.enum(['available', 'pending', 'adopted']).default('available'),
  ),
  energy: enumParam(['low', 'medium', 'high']),
  q: optionalText(100),
  sort: z.preprocess(
    value => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.enum(['newest', 'name', 'age_asc', 'age_desc']).default('newest'),
  ),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).default(12).transform(value => Math.min(value, 24)),
}).strict();

export const uuidParamSchema = z.string().uuid();
export const savedPetsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).default(12).transform(value => Math.min(value, 50)),
}).strict();

export function validationError(res, message, details = []) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, details } });
}
