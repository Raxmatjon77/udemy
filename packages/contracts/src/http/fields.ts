import { z } from 'zod';

/**
 * Reusable field schemas that encode the domain value-object rules of design §4 at the
 * HTTP boundary. The domain VOs stay authoritative; these give early 400s, form
 * validation in the web apps and documentation in Swagger.
 *
 * Only zod "overwrites" (`trim`, `toLowerCase`) and refinements are used, never
 * `.transform()`: they keep the input/output types identical, so Swagger 12 can render
 * both the request (input) and response (output) JSON Schema. Refinements are simply
 * not represented in the JSON Schema.
 */

const CONTROL_CHAR = /\p{Cc}/u;
const LINE_BREAK_OR_TAB = /[\t\n\r]/g;

/** True when the value has no control characters (single-line text). */
function hasNoControlChars(value: string): boolean {
  return !CONTROL_CHAR.test(value);
}

/** True when the value has no control characters other than tab, CR and LF (multi-line text). */
function hasNoControlCharsExceptLineBreaks(value: string): boolean {
  return !CONTROL_CHAR.test(value.replace(LINE_BREAK_OR_TAB, ''));
}

export const UuidSchema = z.uuid();

/** Response timestamps: ISO 8601 with offset (the api serialises `Date` as UTC `...Z`). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Email in requests: trimmed and lowercased, ≤254 chars, local part ≤64.
 * NFKC normalisation is left to the domain `Email` VO (the `@`/ASCII pattern below already
 * rejects anything NFKC would change in practice). No provider-specific dot stripping.
 */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(z.regexes.email, 'Invalid email address')
  .refine((email) => email.slice(0, email.lastIndexOf('@')).length <= 64, {
    message: 'The part before @ must be at most 64 characters',
  })
  .meta({ format: 'email', examples: ['jane@example.com'] });

/**
 * A new password (signup, reset, change): 10–128 chars, no composition rules (NIST 800-63B).
 * Never trimmed. "Not the email", "not a common password" are checked by the api domain.
 */
export const NewPasswordSchema = z.string().min(10).max(128);

/**
 * An existing password (login, current password). Only the upper bound (Argon2 DoS guard)
 * applies, so a policy change never locks anybody out with a 400.
 */
export const CurrentPasswordSchema = z.string().min(1).max(128);

/** Display name: trimmed, 1–60 chars, no control characters. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(hasNoControlChars, { message: 'Must not contain control characters' });

/** Profile headline: trimmed, 1–60 chars, single line. */
export const HeadlineSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(hasNoControlChars, { message: 'Must not contain control characters' });

/** Profile bio: plain text, trimmed, 1–4000 chars, line breaks allowed. */
export const BioSchema = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine(hasNoControlCharsExceptLineBreaks, { message: 'Must not contain control characters' });

/**
 * Free text written by a person (motivation, reasons, notes): trimmed, line breaks allowed,
 * no other control characters.
 */
export function multilineText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(hasNoControlCharsExceptLineBreaks, { message: 'Must not contain control characters' });
}

/** Ban and rejection reasons: 10–1000 chars. */
export const DecisionReasonSchema = multilineText(10, 1000);

/** An https URL, ≤2048 chars, no whitespace, with a dotted host name. */
export const HttpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https:\/\/\S+$/, 'Must be an https:// URL')
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname.includes('.');
    },
    { message: 'Must be a valid https:// URL' },
  )
  .meta({ format: 'uri' });

/**
 * Opaque single-use or refresh token sent back by a client. Deliberately lenient (the
 * exact format is an api detail), so garbage gets the domain error (`invalid_token`,
 * `invalid_refresh_token`) and logout still returns 204.
 */
export const OpaqueTokenSchema = z.string().min(1).max(512);
