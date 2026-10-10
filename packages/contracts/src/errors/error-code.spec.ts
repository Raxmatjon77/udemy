import { describe, expect, it } from 'vitest';
import { ProblemDetailsSchema, type ProblemDetails } from '../http/problem-details';
import { ERROR_CODES, ErrorCode, ErrorCodeSchema, isErrorCode } from './error-code';

describe('ErrorCode', () => {
  it('has unique snake_case values', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });

  it('includes the codes the design and the api already emit', () => {
    for (const code of [
      'validation_failed',
      'invalid_credentials',
      'app_access_denied',
      'invalid_refresh_token',
      'self_decision_forbidden',
      'target_is_admin',
      'client_not_allowed',
      'invalid_current_password',
    ]) {
      expect(isErrorCode(code)).toBe(true);
    }
    expect(ErrorCodeSchema.safeParse('nope').success).toBe(false);
  });

  it('includes every Phase 2 catalog & media code (design §5, §8)', () => {
    for (const code of [
      'course_not_found',
      'section_not_found',
      'lecture_not_found',
      'category_not_found',
      'media_asset_not_found',
      'course_in_review',
      'course_not_editable',
      'course_not_ready',
      'review_already_pending',
      'nothing_to_review',
      'slug_taken',
      'slug_frozen',
      'category_inactive',
      'category_not_leaf',
      'category_depth_exceeded',
      'category_in_use',
      'order_mismatch',
      'curriculum_limit_exceeded',
      'lecture_type_mismatch',
      'preview_not_allowed',
      'markdown_not_allowed',
      'course_published_cannot_delete',
      'restore_forbidden',
      'lecture_locked',
      'media_not_ready',
      'unsupported_media_type',
      'upload_too_large',
      'quota_exceeded',
      'too_many_uploads',
      'upload_not_in_progress',
      'upload_incomplete',
      'upload_size_mismatch',
      'media_purpose_mismatch',
      'media_asset_unusable',
      // reused from Phase 1
      'invalid_state_transition',
      'version_conflict',
      'self_decision_forbidden',
      'rate_limited',
    ]) {
      expect(isErrorCode(code), code).toBe(true);
    }
  });

  it('includes every Phase 4 commerce & enrollment code (design §5)', () => {
    for (const code of [
      'price_not_allowed',
      'course_not_for_sale',
      'course_is_free',
      'course_not_free',
      'cannot_purchase_own_course',
      'already_enrolled',
      'cart_full',
      'cart_empty',
      'cart_changed',
      'price_changed',
      'coupon_invalid',
      'coupon_expired',
      'coupon_not_started',
      'coupon_exhausted',
      'coupon_already_used',
      'coupon_code_taken',
      'coupon_limit_exceeded',
      'checkout_in_progress',
      'idempotency_key_required',
      'idempotency_key_reused',
      'amount_below_minimum',
      'payment_provider_unavailable',
      'order_not_found',
      'order_not_cancelable',
      'order_not_paid',
      'refund_window_closed',
      'refund_not_applicable',
      'refund_already_requested',
      'refund_not_found',
      'enrollment_not_found',
      'webhook_signature_invalid',
      // reused
      'email_not_verified',
      'course_not_found',
      'invalid_state_transition',
      'rate_limited',
      'validation_failed',
    ]) {
      expect(isErrorCode(code), code).toBe(true);
    }
    expect(ErrorCode.EmailNotVerified).toBe('email_not_verified');
  });

  it('is accepted by ProblemDetails, which still allows unknown codes', () => {
    const known: ProblemDetails = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      code: ErrorCode.InvalidCredentials,
    };
    const unknown: ProblemDetails = { ...known, code: 'some_future_code' };
    expect(ProblemDetailsSchema.parse(known)).toEqual(known);
    expect(ProblemDetailsSchema.parse(unknown)).toEqual(unknown);
  });
});
