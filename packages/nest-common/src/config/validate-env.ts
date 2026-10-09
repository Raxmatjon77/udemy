import { z } from 'zod';

/** Thrown at startup when the environment does not match the app's schema. */
export class EnvValidationError extends Error {
  constructor(readonly issues: readonly z.core.$ZodIssue[]) {
    // prettifyError prints paths and messages only, never the (possibly secret) values.
    super(`Invalid environment variables:\n${z.prettifyError(new z.ZodError([...issues]))}`);
    this.name = 'EnvValidationError';
  }
}

/** Parses `raw` (process.env + .env file) with `schema`; throws EnvValidationError on failure. */
export function validateEnv<TSchema extends z.ZodType<Record<string, unknown>>>(
  schema: TSchema,
  raw: Record<string, unknown>,
): z.output<TSchema> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  return result.data;
}
