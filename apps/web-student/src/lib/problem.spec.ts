import { describe, expect, it } from 'vitest';
import { ErrorCode, type ProblemDetails } from '@udemy/contracts';

import { ProxyFetchError } from '@udemy/web-auth/client';

import { formatWait, problemMessage, toFormProblem } from './problem';

function problem(
  status: number,
  code?: string,
  extra: Partial<ProblemDetails> = {},
): ProblemDetails {
  return { type: 'about:blank', title: 'x', status, ...(code ? { code } : {}), ...extra };
}

const err = (status: number, code?: string, extra?: Partial<ProblemDetails>, retryAfter?: string) =>
  new ProxyFetchError(status, problem(status, code, extra), {
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
  });

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
    expect(problemMessage(new ProxyFetchError(503, null))).toMatch(/temporarily unavailable/);
    expect(problemMessage(new ProxyFetchError(500, null))).toMatch(/on our side/);
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

describe('formatWait', () => {
  it('formats waits for humans', () => {
    expect(formatWait(1)).toBe('in 1 second');
    expect(formatWait(45)).toBe('in 45 seconds');
    expect(formatWait(61)).toBe('in about 2 minutes');
    expect(formatWait(3600)).toBe('in about 1 hour');
  });
});
