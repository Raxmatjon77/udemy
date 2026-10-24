import { z } from 'zod';

/**
 * Stable, machine-readable problem `code` values (RFC 7807 extension member).
 * Clients branch on these, never on `title`/`detail`, so a value must never change once
 * released. The HTTP status for each code is decided by the api (DomainError kind).
 */
export const ErrorCode = {
  // Generic
  ValidationFailed: 'validation_failed',
  NotFound: 'not_found',
  Conflict: 'conflict',
  Forbidden: 'forbidden',
  Unauthorized: 'unauthorized',
  RateLimited: 'rate_limited',
  ServiceUnavailable: 'service_unavailable',
  Internal: 'internal',

  // identity: authentication and sessions
  InvalidCredentials: 'invalid_credentials',
  TooManyAttempts: 'too_many_attempts',
  AccountBanned: 'account_banned',
  AppAccessDenied: 'app_access_denied',
  ClientNotAllowed: 'client_not_allowed',
  InvalidRefreshToken: 'invalid_refresh_token',
  /** Access token expired; the BFF refreshes once and retries (design §10). */
  TokenExpired: 'token_expired',
  SessionNotFound: 'session_not_found',

  // identity: passwords and email
  WeakPassword: 'weak_password',
  InvalidCurrentPassword: 'invalid_current_password',
  /** Invalid, expired or already used one-time token (email verification / password reset). */
  InvalidToken: 'invalid_token',
  EmailAlreadyVerified: 'email_already_verified',
  EmailNotVerified: 'email_not_verified',

  // identity / users: accounts and bans
  UserNotFound: 'user_not_found',
  AlreadyBanned: 'already_banned',
  NotBanned: 'not_banned',
  CannotBanSelf: 'cannot_ban_self',
  TargetIsAdmin: 'target_is_admin',

  // access
  RoleNotAssignable: 'role_not_assignable',

  // users: instructor applications
  ApplicationAlreadyPending: 'application_already_pending',
  AlreadyInstructor: 'already_instructor',
  InvalidStateTransition: 'invalid_state_transition',
  VersionConflict: 'version_conflict',
  SelfDecisionForbidden: 'self_decision_forbidden',

  // catalog: lookups (Phase 2)
  CourseNotFound: 'course_not_found',
  SectionNotFound: 'section_not_found',
  LectureNotFound: 'lecture_not_found',
  CategoryNotFound: 'category_not_found',

  // catalog: course working copy and lifecycle
  /** The working copy is locked while a revision is pending (D2); withdraw to edit. */
  CourseInReview: 'course_in_review',
  CourseNotEditable: 'course_not_editable',
  /** Readiness check failed; the problem carries `issues[]` (`CourseNotReadyProblem`). */
  CourseNotReady: 'course_not_ready',
  ReviewAlreadyPending: 'review_already_pending',
  /** The snapshot equals the live revision (same `content_hash`). */
  NothingToReview: 'nothing_to_review',
  SlugTaken: 'slug_taken',
  /** The course slug cannot change after the first publication (D12). */
  SlugFrozen: 'slug_frozen',
  CoursePublishedCannotDelete: 'course_published_cannot_delete',
  RestoreForbidden: 'restore_forbidden',

  // catalog: categories
  CategoryInactive: 'category_inactive',
  CategoryNotLeaf: 'category_not_leaf',
  CategoryDepthExceeded: 'category_depth_exceeded',
  CategoryInUse: 'category_in_use',

  // catalog: curriculum
  /** A reorder is not an exact permutation of the current ids (D3); refetch and retry. */
  OrderMismatch: 'order_mismatch',
  CurriculumLimitExceeded: 'curriculum_limit_exceeded',
  LectureTypeMismatch: 'lecture_type_mismatch',
  PreviewNotAllowed: 'preview_not_allowed',
  /** Raw HTML, images or a non-http(s)/mailto link in markdown (D14). */
  MarkdownNotAllowed: 'markdown_not_allowed',

  // catalog: playback
  LectureLocked: 'lecture_locked',
  MediaNotReady: 'media_not_ready',

  // media: uploads and assets
  MediaAssetNotFound: 'media_asset_not_found',
  MediaPurposeMismatch: 'media_purpose_mismatch',
  MediaAssetUnusable: 'media_asset_unusable',
  UnsupportedMediaType: 'unsupported_media_type',
  UploadTooLarge: 'upload_too_large',
  QuotaExceeded: 'quota_exceeded',
  /** Too many concurrent UPLOADING assets (429). */
  TooManyUploads: 'too_many_uploads',
  UploadNotInProgress: 'upload_not_in_progress',
  /** Parts are missing; the problem carries `missingParts[]` (`UploadIncompleteProblem`). */
  UploadIncomplete: 'upload_incomplete',
  UploadSizeMismatch: 'upload_size_mismatch',

  // commerce: pricing and purchase eligibility (Phase 4, design §4, §5)
  /** The amount is not one of the `PRICE_TIERS` of the platform currency (422). */
  PriceNotAllowed: 'price_not_allowed',
  /** Not PUBLISHED, or no price row (D16) (409). */
  CourseNotForSale: 'course_not_for_sale',
  /** The course costs 0.00: use `POST /me/free-enrollments` instead (409). */
  CourseIsFree: 'course_is_free',
  /** Free enrolment on a paid course (409). */
  CourseNotFree: 'course_not_free',
  CannotPurchaseOwnCourse: 'cannot_purchase_own_course',
  AlreadyEnrolled: 'already_enrolled',

  // commerce: cart and quote
  /** More than `CART_LIMITS.maxItems` items (422). */
  CartFull: 'cart_full',
  CartEmpty: 'cart_empty',
  /** A cart line became unavailable; the problem carries `quote` (`CartChangedProblem`, 409). */
  CartChanged: 'cart_changed',
  /** The total differs from `expectedTotal`; carries `quote` (`PriceChangedProblem`, 409). */
  PriceChanged: 'price_changed',

  // commerce: coupons
  /** Unknown code, or no line in the cart it applies to: one generic code on purpose (§9). */
  CouponInvalid: 'coupon_invalid',
  CouponExpired: 'coupon_expired',
  CouponNotStarted: 'coupon_not_started',
  CouponExhausted: 'coupon_exhausted',
  /** One redemption per user per coupon (D5). */
  CouponAlreadyUsed: 'coupon_already_used',
  CouponCodeTaken: 'coupon_code_taken',
  /** More than `COUPON_LIMITS.maxActivePerCourse` active coupons (422). */
  CouponLimitExceeded: 'coupon_limit_exceeded',

  // commerce: checkout, orders and payments
  /**
   * The user already has a PENDING_PAYMENT order (D15, 409); the problem carries `orderId` and
   * `checkoutUrl` (`CheckoutInProgressProblem`).
   */
  CheckoutInProgress: 'checkout_in_progress',
  /** `POST /me/checkout` without an `Idempotency-Key` header (400). */
  IdempotencyKeyRequired: 'idempotency_key_required',
  /** The same key with a different cart fingerprint (422). */
  IdempotencyKeyReused: 'idempotency_key_reused',
  /** Order total in (0, 0.50): below Stripe's minimum charge (422). */
  AmountBelowMinimum: 'amount_below_minimum',
  /** Stripe could not be reached; retrying with the same key resumes (503). */
  PaymentProviderUnavailable: 'payment_provider_unavailable',
  OrderNotFound: 'order_not_found',
  /** The Checkout Session already completed; the webhook will mark the order PAID (409). */
  OrderNotCancelable: 'order_not_cancelable',
  /** A receipt was requested for an order that was never paid (409). */
  OrderNotPaid: 'order_not_paid',

  // commerce: refunds
  RefundWindowClosed: 'refund_window_closed',
  /** E.g. a 0.00 line, or an order that is not paid (422). */
  RefundNotApplicable: 'refund_not_applicable',
  /** The line already has a live refund (409). */
  RefundAlreadyRequested: 'refund_already_requested',
  RefundNotFound: 'refund_not_found',

  // enrollment
  EnrollmentNotFound: 'enrollment_not_found',

  // webhooks
  /** Stripe-Signature missing, malformed, stale or wrong (400, no detail). */
  WebhookSignatureInvalid: 'webhook_signature_invalid',

  // learning (Phase 5, design §5). Reused: course_not_found, lecture_not_found,
  // lecture_type_mismatch, markdown_not_allowed, invalid_state_transition, rate_limited.
  /** Every learner route needs an ACTIVE enrollment; the owner preview is read-only (403). */
  EnrollmentRequired: 'enrollment_required',
  /** Manual completion of a VIDEO/QUIZ, or a cause that does not match the type (422). */
  CompletionNotAllowed: 'completion_not_allowed',
  NoteNotFound: 'note_not_found',
  /** More than `LEARNING_LIMITS.maxNotesPerCourse` notes in one course (422). */
  NoteLimitExceeded: 'note_limit_exceeded',
  QuizAttemptNotFound: 'quiz_attempt_not_found',
  /** Submit of an ABANDONED attempt (409); a SUBMITTED one returns its stored result. */
  AttemptNotInProgress: 'attempt_not_in_progress',
  /** Unknown question ids, positions out of range, or several selections on SINGLE (422). */
  QuizAnswersInvalid: 'quiz_answers_invalid',
  CertificateNotFound: 'certificate_not_found',
  /** The certificate exists but its PDF is not rendered yet; retry shortly (409). */
  CertificatePdfPending: 'certificate_pdf_pending',

  // catalog: quiz authoring (Phase 5)
  QuizQuestionNotFound: 'quiz_question_not_found',
  /** Option list rejected by the domain (422). */
  QuizOptionsInvalid: 'quiz_options_invalid',
  /** More than `QUIZ_LIMITS.maxQuestions` questions (422). */
  QuizLimitExceeded: 'quiz_limit_exceeded',

  // engagement (Phase 5)
  ReviewNotFound: 'review_not_found',
  /** ACTIVE enrollment but no completed lecture yet (D10, 422). */
  ReviewNotEligible: 'review_not_eligible',
  /** The course owner cannot review their own course (403). */
  CannotReviewOwnCourse: 'cannot_review_own_course',
  ReplyNotFound: 'reply_not_found',
  QuestionNotFound: 'question_not_found',
  AnswerNotFound: 'answer_not_found',
  /** Only the author may edit or delete; accept needs the question author or owner (403). */
  NotContentAuthor: 'not_content_author',
  CannotVoteOwnContent: 'cannot_vote_own_content',
  CannotReportOwnContent: 'cannot_report_own_content',
  AnnouncementNotFound: 'announcement_not_found',
  /**
   * 4 announcements per course per 30 days (D18, 422); the problem carries `retryAt`
   * (`AnnouncementLimitProblem`).
   */
  AnnouncementLimitExceeded: 'announcement_limit_exceeded',
  /** Not PUBLISHED, owned by the caller, or already enrolled (409). */
  CourseNotWishlistable: 'course_not_wishlistable',
  /** More than `WISHLIST_LIMITS.maxItems` items (422). */
  WishlistFull: 'wishlist_full',

  // notifications and realtime (Phase 5)
  NotificationNotFound: 'notification_not_found',
  /** A transactional category/channel cannot be turned off (422). */
  PreferenceLocked: 'preference_locked',
  /** Malformed, forged or wrong-version unsubscribe token (400). */
  InvalidUnsubscribeToken: 'invalid_unsubscribe_token',
  /** The ticket store (Redis) is unavailable (503). */
  RealtimeUnavailable: 'realtime_unavailable',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES = Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}

/**
 * The type of `ProblemDetails.code`: every known code autocompletes, but any string is
 * still accepted (DomainError codes are plain strings, and future codes must not break
 * older clients).
 */
export type ProblemCode = ErrorCode | (string & {});
