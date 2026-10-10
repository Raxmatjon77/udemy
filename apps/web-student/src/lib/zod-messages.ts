import { zodResolver } from '@hookform/resolvers/zod';
import type { FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/**
 * Friendlier wording for zod's built-in issues, applied per parse (it never changes the
 * shared contracts schemas). Messages written into a schema (`'Invalid email address'`) win.
 */
export const friendlyZodError: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') {
        return issue.minimum === 1
          ? 'This field is required.'
          : `Must be at least ${String(issue.minimum)} characters.`;
      }
      return undefined;
    case 'too_big':
      if (issue.origin === 'string') return `Must be at most ${String(issue.maximum)} characters.`;
      return undefined;
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null) return 'This field is required.';
      return undefined;
    case 'invalid_value':
      return 'Choose one of the options.';
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter a valid email address.';
      if (issue.format === 'url') return 'Enter a valid URL.';
      return undefined;
    default:
      return undefined;
  }
};

/** `zodResolver` with the friendly messages; the form receives the schema's OUTPUT values. */
export function formResolver<S extends z.ZodType<unknown, FieldValues>>(
  schema: S,
): Resolver<z.input<S>, unknown, z.output<S>> {
  return zodResolver(schema, { error: friendlyZodError });
}
