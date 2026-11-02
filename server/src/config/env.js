// server/src/config/env.js
// Validates environment variables at startup. Import this after dotenv is loaded.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV:          z.enum(['development', 'test', 'production']).default('development'),
  PORT:              z.coerce.number().int().min(1).max(65535).default(5000),
  DATABASE_URL:      z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),
  JWT_SECRET:        z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  COOKIE_SECURE:     z
    .enum(['true', 'false'])
    .default('false')
    .transform(v => v === 'true'),
  TRUST_PROXY:       z
    .enum(['true', 'false'])
    .default('false')
    .transform(v => v === 'true'),
  SEED_PASSWORD:     z.string().min(8).default('PawPal@2026'),
});

const productionDefaults = new Set([
  'change-me-to-a-random-string-that-is-at-least-32-chars!!',
  'change-me',
  'secret',
  'your-secret-key',
  'replace_with_a_random_secret_of_at_least_32_characters',
]);

if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32 || productionDefaults.has(secret.toLowerCase()) || /^(?:replace|change|your)[_-].*(?:placeholder|with)/i.test(secret)) {
    console.error('[env] Production requires a non-default JWT_SECRET of at least 32 characters.');
    process.exit(1);
  }
}

const result = schema.safeParse(process.env);

if (!result.success) {
  const issues = result.error.issues
    .map(i => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`[env] Environment validation failed:\n${issues}`);
  process.exit(1);
}

export const env = result.data;

