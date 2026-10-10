import { describe, expect, it } from 'vitest';
import { ErrorCode, type ProblemDetails } from '@udemy/contracts';

import { ApiError, formatWait, problemMessage, retryAfterSeconds, toFormProblem } from './problem';

function problem(
  status: number,
  code?: string,
  extra: Partial<ProblemDetails> = {},
): ProblemDetails {
  return { type: 'about:blank', title: 'x', status, ...(code ? { code } : {}), ...extra };
}

const err = (status: number, code?: string, extra?: Partial<ProblemDetails>, retryAfter?: string) =>
  new ApiError(status, problem(status, code, extra), retryAfter ?? null);

describe('problemMessage', () => {
  it('maps known codes to their message, regardless of status', () => {
    expect(problemMessage(err(401, ErrorCode.InvalidCredentials))).toBe(
      'The email or password is incorrect.',
    );
    expect(problemMessage(err(400, ErrorCode.InvalidToken))).toMatch(/invalid, has expired/);
  });

  it('adds the Retry-After wait to rate-limit messages', () => {
    expect(problemMessage(err(429, ErrorCode.TooManyAttempts, {}, '120'))).toBe(
      'Too many sign-in attempts. Try again in about 2 minutes.',
    );
    expect(problemMessage(err(429, ErrorCode.TooManyAttempts))).toMatch(/wait a little/);
  });

  it('lets a screen override a code', () => {
    expect(
      problemMessage(err(403, ErrorCode.AppAccessDenied), {
        [ErrorCode.AppAccessDenied]: 'Instructors only.',
      }),
    ).toBe('Instructors only.');
  });

  it('falls back to the status for unknown codes or bodies', () => {
    expect(problemMessage(err(409, 'something_new'))).toMatch(/changed in the meantime/);
    expect(problemMessage(new ApiError(503, null))).toMatch(/temporarily unavailable/);
    expect(problemMessage(new ApiError(500, null))).toMatch(/on our side/);
  });

  it('treats non-API errors as network failures', () => {
    expect(problemMessage(new TypeError('Failed to fetch'))).toMatch(/could not reach the server/);
  });
});

describe('toFormProblem', () => {
  const fields = ['email', 'password'] as const;

  it('puts a code mapped to a field under that field', () => {
    expect(
      toFormProblem(err(422, ErrorCode.WeakPassword), {
        fields,
        codeFields: { [ErrorCode.WeakPassword]: 'password' },
      }),
    ).toEqual({ fieldErrors: { password: expect.stringMatching(/too easy/) }, formError: null });
  });

  it('maps validation errors[] by the first path segment, first message wins', () => {
    const error = err(400, ErrorCode.ValidationFailed, {
      errors: [
        { path: 'email', message: 'Bad email' },
        { path: 'email', message: 'Second' },
        { path: 'nested.0.x', message: 'Unknown field' },
      ],
    });
    expect(toFormProblem(error, { fields })).toEqual({
      fieldErrors: { email: 'Bad email' },
      formError: null,
    });
  });

  it('uses a form-level message when no field applies', () => {
    expect(toFormProblem(err(401, ErrorCode.InvalidCredentials), { fields })).toEqual({
      fieldErrors: {},
      formError: 'The email or password is incorrect.',
    });
    expect(toFormProblem(err(400, ErrorCode.ValidationFailed), { fields }).formError).toMatch(
      /not valid/,
    );
  });
});

describe('ApiError.fromResponse', () => {
  it('parses a problem body and the Retry-After header', async () => {
    const response = new Response(JSON.stringify(problem(429, ErrorCode.RateLimited)), {
      status: 429,
      headers: { 'content-type': 'application/problem+json', 'retry-after': '30' },
    });
    const error = await ApiError.fromResponse(response);
    expect(error.status).toBe(429);
    expect(error.code).toBe(ErrorCode.RateLimited);
    expect(error.retryAfter).toBe('30');
  });

  it('tolerates a non-JSON body', async () => {
    const error = await ApiError.fromResponse(new Response('<html>', { status: 502 }));
    expect(error.problem).toBeNull();
    expect(error.status).toBe(502);
  });
});

describe('retryAfterSeconds / formatWait', () => {
  it('parses delta-seconds and HTTP dates', () => {
    expect(retryAfterSeconds('90')).toBe(90);
    const now = Date.parse('2026-10-10T10:00:00Z');
    expect(retryAfterSeconds('Sat, 10 Oct 2026 10:01:00 GMT', now)).toBe(60);
    expect(retryAfterSeconds('soon')).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
  });

  it('formats waits for humans', () => {
    expect(formatWait(1)).toBe('in 1 second');
    expect(formatWait(45)).toBe('in 45 seconds');
    expect(formatWait(61)).toBe('in about 2 minutes');
    expect(formatWait(3600)).toBe('in about 1 hour');
  });
});
