import { z } from 'zod';

const uuid = z.string().uuid();
const trimmed = max => z.string().trim().min(1).max(max);

export const applicationIdSchema = z.object({ id: uuid });
export const createApplicationSchema = z.object({
  petId: uuid,
  applicantName: trimmed(120),
  applicantEmail: z.string().trim().email().max(254),
  contactNo: trimmed(40),
  addressLine: trimmed(240),
  city: trimmed(100),
  state: z.string().trim().max(100).optional().nullable(),
  postcode: z.string().trim().max(20).optional().nullable(),
  homeType: z.enum(['apartment', 'house_no_yard', 'house_with_yard', 'farm_acreage']),
  ownership: z.enum(['own', 'rent', 'family_home']),
  householdAdults: z.number().int().min(1).max(20),
  hasChildren: z.boolean(),
  youngestChildAge: z.number().int().min(0).max(17).optional().nullable(),
  otherPets: z.string().max(1000).default(''),
  experience: z.enum(['first_time', 'some', 'experienced']),
  hoursAlonePerDay: z.number().int().min(0).max(24),
  reason: z.string().trim().min(10).max(3000),
}).superRefine((data, ctx) => {
  if (!data.hasChildren && data.youngestChildAge != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['youngestChildAge'], message: 'Age is only applicable when children live in the household.' });
  }
});

export const applicationListQuerySchema = z.object({
  status: z.enum(['submitted', 'under_review', 'approved', 'rejected', 'completed']).optional(),
  q: z.string().trim().max(120).optional().default(''),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

export const updateChecksSchema = z.object({
  checks: z.array(z.object({
    checkType: z.enum(['identity', 'address', 'landlord_permission', 'household_agreement', 'home_check', 'vet_reference', 'interview']),
    result: z.enum(['pending', 'passed', 'failed', 'not_applicable']),
    notes: z.string().trim().max(1000).optional().nullable(),
  })).min(1).max(7),
});

export const transitionSchema = z.object({
  to: z.enum(['under_review', 'approved', 'rejected', 'completed']),
  note: z.string().trim().max(2000).optional().nullable(),
}).superRefine((data, ctx) => {
  if (data.to === 'rejected' && !data.note?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'A note is required when rejecting an application.' });
  }
});
