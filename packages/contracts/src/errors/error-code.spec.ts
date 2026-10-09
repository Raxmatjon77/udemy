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

  it('is accepted by ProblemDetails, which still allows unknown codes', () => {
    const known: ProblemDetails = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      code: ErrorCode.InvalidCredentials,
    };
    const unknown: ProblemDetails = { ...known, code: 'course_not_found' };
    expect(ProblemDetailsSchema.parse(known)).toEqual(known);
    expect(ProblemDetailsSchema.parse(unknown)).toEqual(unknown);
  });
});
