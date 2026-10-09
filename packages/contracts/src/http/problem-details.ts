import { z } from 'zod';
import { ERROR_CODES, type ProblemCode } from '../errors/error-code';

/** One field-level problem, e.g. from request validation. */
export const ProblemFieldErrorSchema = z.object({
  /** Dotted path to the offending field (`items.0.price`); empty for the root. */
  path: z.string(),
  message: z.string(),
});

/**
 * RFC 7807 / RFC 9457 problem details, served as `application/problem+json`.
 * `traceId` and `errors` are extension members; unknown extensions are allowed.
 */
export const ProblemDetailsSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /**
   * Machine-readable error code, stable across releases (e.g. `invalid_credentials`).
   * Known values are listed in `ErrorCode`; unknown strings are accepted for forward compatibility.
   */
  code: z
    .string()
    .meta({ description: `Stable error code. Known values: ${ERROR_CODES.join(', ')}.` })
    .optional(),
  /** Request id, also in the `x-request-id` response header and the logs. */
  traceId: z.string().optional(),
  errors: z.array(ProblemFieldErrorSchema).optional(),
});

export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;
/** `code` is narrowed to `ProblemCode` so known codes autocomplete; any string still type-checks. */
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema> & { code?: ProblemCode };

export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';
