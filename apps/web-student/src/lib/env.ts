import { z } from 'zod';

/**
 * Typed, validated environment for this app.
 *
 * NEXT_PUBLIC_* values are inlined at build time, so each one must be read with a literal
 * `process.env.NAME` access (no destructuring or dynamic keys). Validation runs once at
 * module load and fails fast with a readable error.
 */
const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000/api/v1'),
});

const parsed = envSchema.safeParse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});

if (!parsed.success) {
  throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
