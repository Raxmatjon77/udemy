import { ErrorCode, ProblemDetailsSchema, type ProblemDetails } from '@udemy/contracts';

/**
 * Turning API problems (`application/problem+json`, design §8) into words a user can act on.
 * The UI branches on the stable `code` only, never on `title`/`detail` (those are for developers).
 */

/** A non-2xx answer from the BFF (`/api/auth/*` or `/api/proxy/*`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
    /** Raw `Retry-After` header (seconds or an HTTP date), when the server sent one. */
    readonly retryAfter: string | null = null,
    options?: ErrorOptions,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`, options);
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    return this.problem?.code;
  }

  /** Builds the error from a failed response, tolerating non-JSON bodies. */
  static async fromResponse(response: Response): Promise<ApiError> {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = undefined;
    }
    const parsed = ProblemDetailsSchema.safeParse(raw);
    return new ApiError(
      response.status,
      parsed.success ? parsed.data : null,
      response.headers.get('retry-after'),
    );
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function hasCode(error: unknown, code: ErrorCode): boolean {
  return isApiError(error) && error.code === code;
}

/** `Retry-After` in seconds from now (delta-seconds or HTTP-date form), or null. */
export function retryAfterSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** "in 45 seconds", "in about 3 minutes", "in about 2 hours". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `in ${Math.max(1, seconds)} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

function waitSuffix(error: ApiError): string {
  const seconds = retryAfterSeconds(error.retryAfter);
  return seconds === null
    ? 'Please wait a little and try again.'
    : `Try again ${formatWait(seconds)}.`;
}

type Message = string | ((error: ApiError) => string);
export type MessageOverrides = Partial<Record<ErrorCode | (string & {}), Message>>;

/** Default wording per code. Screens override the ones that need context (see `overrides`). */
const MESSAGES: Partial<Record<ErrorCode, Message>> = {
  [ErrorCode.ValidationFailed]: 'Some of the information you entered is not valid.',
  [ErrorCode.NotFound]: 'We could not find what you were looking for.',
  [ErrorCode.Conflict]: 'This was changed in the meantime. Refresh the page and try again.',
  [ErrorCode.Forbidden]: 'You do not have permission to do that.',
  [ErrorCode.Unauthorized]: 'Your session has ended. Please log in again.',
  [ErrorCode.RateLimited]: (error) => `Too many requests. ${waitSuffix(error)}`,
  [ErrorCode.ServiceUnavailable]:
    'The service is temporarily unavailable. Please try again in a moment.',
  [ErrorCode.Internal]: 'Something went wrong on our side. Please try again in a moment.',

  [ErrorCode.InvalidCredentials]: 'The email or password is incorrect.',
  [ErrorCode.TooManyAttempts]: (error) => `Too many sign-in attempts. ${waitSuffix(error)}`,
  [ErrorCode.AccountBanned]:
    'This account has been suspended. Contact support if you think this is a mistake.',
  [ErrorCode.AppAccessDenied]: 'This account cannot sign in to this app.',
  [ErrorCode.ClientNotAllowed]: 'This action is not available here.',
  [ErrorCode.InvalidRefreshToken]: 'Your session has ended. Please log in again.',
  [ErrorCode.TokenExpired]: 'Your session has ended. Please log in again.',
  [ErrorCode.SessionNotFound]: 'That session has already ended.',

  [ErrorCode.WeakPassword]:
    'This password is too easy to guess. Use a longer phrase that is not your email or a common password.',
  [ErrorCode.InvalidCurrentPassword]: 'Your current password is incorrect.',
  [ErrorCode.InvalidToken]: 'This link is invalid, has expired or has already been used.',
  [ErrorCode.EmailAlreadyVerified]: 'Your email address is already verified.',
  [ErrorCode.EmailNotVerified]: 'Verify your email address first.',

  [ErrorCode.UserNotFound]: 'This user does not exist.',
  [ErrorCode.AlreadyBanned]: 'This user is already banned.',
  [ErrorCode.NotBanned]: 'This user is not banned.',
  [ErrorCode.CannotBanSelf]: 'You cannot ban your own account.',
  [ErrorCode.TargetIsAdmin]: 'Administrators cannot be banned.',
  [ErrorCode.RoleNotAssignable]: 'This role cannot be assigned.',

  [ErrorCode.ApplicationAlreadyPending]: 'You already have an application under review.',
  [ErrorCode.AlreadyInstructor]: 'You are already an instructor.',
  [ErrorCode.InvalidStateTransition]: 'This application has already been decided or withdrawn.',
  [ErrorCode.VersionConflict]:
    'Someone else changed this in the meantime. Review the latest version and try again.',
  [ErrorCode.SelfDecisionForbidden]: 'You cannot decide on your own application.',
};

function byStatus(error: ApiError): string {
  const { status } = error;
  if (status === 400 || status === 422) return MESSAGES[ErrorCode.ValidationFailed] as string;
  if (status === 401) return MESSAGES[ErrorCode.Unauthorized] as string;
  if (status === 403) return MESSAGES[ErrorCode.Forbidden] as string;
  if (status === 404) return MESSAGES[ErrorCode.NotFound] as string;
  if (status === 409) return MESSAGES[ErrorCode.Conflict] as string;
  if (status === 413) return 'What you sent is too large.';
  if (status === 429) return `Too many requests. ${waitSuffix(error)}`;
  if (status === 502 || status === 503 || status === 504) {
    return MESSAGES[ErrorCode.ServiceUnavailable] as string;
  }
  return MESSAGES[ErrorCode.Internal] as string;
}

const NETWORK_MESSAGE = 'We could not reach the server. Check your connection and try again.';

/** A user-facing sentence for any error thrown by an API call. */
export function problemMessage(error: unknown, overrides: MessageOverrides = {}): string {
  if (!isApiError(error)) return NETWORK_MESSAGE;
  const code = error.code;
  const message = (code && overrides[code]) ?? (code && MESSAGES[code as ErrorCode]);
  if (message) return typeof message === 'function' ? message(error) : message;
  return byStatus(error);
}

export interface FormProblem<F extends string> {
  /** Messages to show under specific fields. */
  fieldErrors: Partial<Record<F, string>>;
  /** A form-level message, when the problem is not about a single field. */
  formError: string | null;
}

export interface FormProblemOptions<F extends string> {
  /** The form's field names; `errors[].path` entries naming one of them become field errors. */
  fields: readonly F[];
  /** Codes that belong to one field, e.g. `{ weak_password: 'password' }`. */
  codeFields?: Partial<Record<ErrorCode | (string & {}), F>>;
  messages?: MessageOverrides;
}

/**
 * Splits an API error into field errors and a form-level message:
 * 1. a code listed in `codeFields` goes under that field;
 * 2. a 400 with `errors[]` puts each entry under the field its `path` starts with;
 * 3. anything else (or a 400 without usable paths) becomes the form-level message.
 */
export function toFormProblem<F extends string>(
  error: unknown,
  { fields, codeFields = {}, messages = {} }: FormProblemOptions<F>,
): FormProblem<F> {
  const fieldErrors: Partial<Record<F, string>> = {};
  if (isApiError(error)) {
    const code = error.code;
    const field = code ? codeFields[code] : undefined;
    if (field) {
      fieldErrors[field] = problemMessage(error, messages);
      return { fieldErrors, formError: null };
    }
    if (error.status === 400 && error.problem?.errors?.length) {
      const known = new Set<string>(fields);
      for (const issue of error.problem.errors) {
        const head = issue.path.split('.')[0] ?? '';
        if (known.has(head) && !fieldErrors[head as F]) fieldErrors[head as F] = issue.message;
      }
      if (Object.keys(fieldErrors).length > 0) return { fieldErrors, formError: null };
    }
  }
  return { fieldErrors, formError: problemMessage(error, messages) };
}
