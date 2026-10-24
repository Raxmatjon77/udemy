import { ErrorCode } from '@udemy/contracts';
import { ProxyFetchError } from '@udemy/web-auth/client';

/**
 * Turning API problems (`application/problem+json`, design §8) into words a user can act on.
 * The UI branches on the stable `code` only, never on `title`/`detail` (those are for developers).
 */

/**
 * A non-2xx answer from the BFF (`/api/auth/*` or `/api/proxy/*`): a `ProxyFetchError` from
 * @udemy/web-auth, with the status, the parsed problem (or null), the response headers and
 * `retryAfterSeconds`.
 */
export function isApiError(error: unknown): error is ProxyFetchError {
  return error instanceof ProxyFetchError;
}

export function hasCode(error: unknown, code: ErrorCode): boolean {
  return isApiError(error) && error.code === code;
}

/** "in 45 seconds", "in about 3 minutes", "in about 2 hours". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `in ${Math.max(1, seconds)} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

function waitSuffix(error: ProxyFetchError): string {
  const seconds = error.retryAfterSeconds;
  return seconds === null
    ? 'Please wait a little and try again.'
    : `Try again ${formatWait(seconds)}.`;
}

type Message = string | ((error: ProxyFetchError) => string);
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

  // catalog (Phase 2)
  [ErrorCode.CourseNotFound]: 'This course does not exist or is not yours.',
  [ErrorCode.SectionNotFound]: 'This section no longer exists. The curriculum was reloaded.',
  [ErrorCode.LectureNotFound]: 'This lecture no longer exists. The curriculum was reloaded.',
  [ErrorCode.CategoryNotFound]: 'This category does not exist.',
  [ErrorCode.CourseInReview]:
    'The course is waiting for review and cannot be changed. Withdraw it from review to edit.',
  [ErrorCode.CourseNotEditable]: 'This course cannot be changed in its current state.',
  [ErrorCode.CourseNotReady]: 'The course is not ready for review yet. Fix the items listed.',
  [ErrorCode.ReviewAlreadyPending]: 'This course is already waiting for review.',
  [ErrorCode.NothingToReview]:
    'Nothing changed since the published version, so there is nothing to review.',
  [ErrorCode.SlugTaken]: 'This URL is already used by another course.',
  [ErrorCode.SlugFrozen]: 'The course URL cannot change after the course was published.',
  [ErrorCode.CoursePublishedCannotDelete]:
    'A course that was published cannot be deleted. Archive it instead.',
  [ErrorCode.RestoreForbidden]: 'Only a moderator can restore this course.',
  [ErrorCode.CategoryInactive]: 'This category is no longer available. Choose another one.',
  [ErrorCode.CategoryNotLeaf]: 'Choose a subcategory, not a top-level category.',
  [ErrorCode.OrderMismatch]:
    'The curriculum was changed somewhere else. We reloaded it; please try again.',
  [ErrorCode.CurriculumLimitExceeded]: 'The curriculum has reached its maximum size.',
  [ErrorCode.LectureTypeMismatch]: 'This does not fit the lecture type.',
  [ErrorCode.PreviewNotAllowed]:
    'This lecture cannot be a free preview (only videos and articles, at most 10 per course).',
  [ErrorCode.MarkdownNotAllowed]:
    'The text contains formatting that is not allowed (HTML, images or unsafe links).',
  [ErrorCode.MediaNotReady]: 'The file is still being processed.',

  // media (Phase 2)
  [ErrorCode.MediaAssetNotFound]: 'This file does not exist (any more).',
  [ErrorCode.MediaPurposeMismatch]: 'This file cannot be used here.',
  [ErrorCode.MediaAssetUnusable]:
    'This file can no longer be used (it failed, was cancelled or is used elsewhere). Upload it again.',
  [ErrorCode.UnsupportedMediaType]: 'This file type is not supported here.',
  [ErrorCode.UploadTooLarge]: 'This file is too large.',
  [ErrorCode.QuotaExceeded]: 'Your storage quota is used up. Remove unused uploads first.',
  [ErrorCode.TooManyUploads]: (error) =>
    `You have too many uploads in progress. Finish or cancel one first. ${waitSuffix(error)}`,
  [ErrorCode.UploadNotInProgress]: 'This upload is no longer in progress. Start it again.',
  [ErrorCode.UploadIncomplete]: 'Some parts of the file did not arrive. Retrying them…',
  [ErrorCode.UploadSizeMismatch]:
    'The uploaded file does not match the size that was announced. Please upload it again.',

  // quizzes (Phase 5)
  [ErrorCode.QuizQuestionNotFound]: 'This question no longer exists. The quiz was reloaded.',
  [ErrorCode.QuizOptionsInvalid]: 'Each question needs 2 to 6 options with different texts.',
  [ErrorCode.QuizLimitExceeded]: 'A quiz can have at most 50 questions.',

  // engagement (Phase 5)
  [ErrorCode.QuestionNotFound]: 'This question no longer exists or was hidden.',
  [ErrorCode.AnswerNotFound]: 'This answer no longer exists or was hidden.',
  [ErrorCode.NotContentAuthor]: 'Only the author can change this.',
  [ErrorCode.ReviewNotFound]: 'This review no longer exists.',
  [ErrorCode.ReplyNotFound]: 'This reply no longer exists.',
  [ErrorCode.AnnouncementNotFound]: 'This announcement no longer exists.',
  [ErrorCode.AnnouncementLimitExceeded]:
    'This course has reached its limit of 4 announcements in 30 days.',
  [ErrorCode.EnrollmentRequired]: 'Only the course owner and its students can do this.',
};

function byStatus(error: ProxyFetchError): string {
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
