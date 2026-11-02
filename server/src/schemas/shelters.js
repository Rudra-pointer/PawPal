import { z } from 'zod';

const text = max => z.string().trim().min(1).max(max);

export const shelterProfileSchema = z.object({
  name: text(160),
  description: z.string().trim().max(4000).default(''),
  addressLine: text(240),
  city: text(100),
  state: text(100),
  postcode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().min(2).max(80).default('US'),
  contactEmail: z.string().trim().email().max(254),
  contactPhone: z.string().trim().max(40).optional().nullable(),
  website: z.string().trim().url().max(500).optional().or(z.literal('')).nullable(),
});

export const shelterUpdateSchema = shelterProfileSchema.partial().refine(data => Object.keys(data).length > 0, 'Provide at least one field to update.');
