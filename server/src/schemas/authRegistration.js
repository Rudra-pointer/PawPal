import { z } from 'zod';

export const userCodePattern = /^[A-Za-z0-9_.-]{3,30}$/;

export const registrationSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  userCode: z.string().trim().regex(userCodePattern),
  contactNo: z.string().trim().max(40).optional().default(''),
  password: z.string().min(8).regex(/[A-Za-z]/).regex(/[0-9]/),
  role: z.enum(['adopter', 'shelter']),
});
