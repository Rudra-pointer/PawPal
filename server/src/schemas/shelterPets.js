import { z } from 'zod';
import { speciesNameSchema } from './species.js';

const uuid = z.string().uuid();
const temperamentTags = ['playful','calm','affectionate','gentle','curious','energetic','independent','shy','social','protective','vocal','quiet','cuddly','loyal','food_motivated','trainable'];
const petFields = {
  name: z.string().trim().min(1).max(120),
  species: speciesNameSchema,
  breed: z.string().trim().min(1).max(120).default('Mixed breed'),
  ageMonths: z.number().int().min(2, 'Puppies and kittens must be at least 8 weeks old before they can be listed.').max(300),
  gender: z.enum(['male', 'female', 'unknown']).default('unknown'),
  size: z.enum(['small', 'medium', 'large', 'xlarge']),
  weightKg: z.number().positive().max(999).optional().nullable(),
  coat: z.string().trim().max(120).optional().nullable(),
  colors: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  description: z.string().trim().max(5000).default(''),
  temperament: z.array(z.enum(temperamentTags)).max(16).default([]),
  energyLevel: z.enum(['low', 'medium', 'high']).default('medium'),
  spayedNeutered: z.boolean().default(false),
  microchipped: z.boolean().default(false),
  houseTrained: z.boolean().default(false),
  specialNeeds: z.boolean().default(false),
  specialNeedsNotes: z.string().trim().max(3000).optional().nullable(),
  healthNotes: z.string().trim().max(3000).optional().nullable(),
  goodWithChildren: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  goodWithDogs: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  goodWithCats: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  bondedPetId: uuid.optional().nullable(),
};

function petAgeRule(data, context) {
  if (data.ageMonths != null && data.ageMonths < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ageMonths'], message: 'Puppies and kittens must be at least 8 weeks old before they can be listed.' });
  }
}

export const createPetSchema = z.object(petFields).superRefine(petAgeRule);
export const updatePetSchema = z.object(petFields).partial().refine(data => Object.keys(data).length > 0, 'Provide at least one pet field to update.').superRefine(petAgeRule);

export const shelterPetListSchema = z.object({
  q: z.string().trim().max(120).optional().default(''),
  species: speciesNameSchema.optional(),
  status: z.enum(['available','pending','adopted','removed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

export const petIdParamsSchema = z.object({ petId: uuid });
export const petPhotoParamsSchema = z.object({ petId: uuid, photoId: uuid });
export const vaccineParamsSchema = z.object({ petId: uuid, vaccinationId: uuid });
export const photoOrderSchema = z.object({ photoIds: z.array(uuid).min(1).max(6) });
export const vaccinationSchema = z.object({
  vaccineTypeId: z.coerce.number().int().positive(),
  givenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid vaccination date.'),
  nextDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  clinic: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(1200).optional().nullable(),
}).superRefine((value, context) => {
  const date = value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!date(value.givenOn)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['givenOn'], message: 'Enter a valid vaccination date.' });
  if (value.nextDueOn && !date(value.nextDueOn)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextDueOn'], message: 'Enter a valid next due date.' });
  if (value.nextDueOn && value.nextDueOn <= value.givenOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextDueOn'], message: 'The next due date must be after the given date.' });
});

export const speciesQuerySchema = z.object({ species: speciesNameSchema });
