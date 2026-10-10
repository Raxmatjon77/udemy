import { describe, expect, it } from 'vitest';
import { EmailSchema, LoginRequestSchema, NewPasswordSchema } from '@udemy/contracts';
import { z } from 'zod';

import { friendlyZodError } from './zod-messages';

const firstMessage = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value, { error: friendlyZodError }).error?.issues[0]?.message;

describe('friendlyZodError', () => {
  it('rewrites length issues', () => {
    expect(firstMessage(NewPasswordSchema, 'short')).toBe('Must be at least 10 characters.');
    expect(firstMessage(NewPasswordSchema, 'x'.repeat(129))).toBe(
      'Must be at most 128 characters.',
    );
    expect(firstMessage(LoginRequestSchema.shape.password, '')).toBe('This field is required.');
  });

  it('keeps messages written into the contract schema', () => {
    expect(firstMessage(EmailSchema, 'not-an-email')).toBe('Invalid email address');
  });

  it('explains enum and missing values', () => {
    expect(firstMessage(z.enum(['A', 'B']), '')).toBe('Choose one of the options.');
    expect(firstMessage(z.object({ a: z.string() }), {})).toBe('This field is required.');
  });
});
