import { type CallHandler, type ExecutionContext, HttpException } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { toProblemDetails } from '../../../shared/errors';
import {
  EmailAlreadyVerified,
  InvalidCurrentPassword,
  InvalidOneTimeToken,
  WeakPassword,
} from '../domain/identity.errors';
import { BadRequestErrorsInterceptor } from './bad-request-errors.interceptor';

const context = {} as ExecutionContext;
const failingWith = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });

async function problemFor(error: unknown) {
  const thrown = await firstValueFrom(
    new BadRequestErrorsInterceptor().intercept(context, failingWith(error)),
  ).catch((e: unknown) => e);
  return { thrown, problem: toProblemDetails(thrown, { exposeInternals: false }) };
}

describe('BadRequestErrorsInterceptor', () => {
  it('answers invalid_token with 400 problem details', async () => {
    const { thrown, problem } = await problemFor(new InvalidOneTimeToken());
    expect(thrown).toBeInstanceOf(HttpException);
    expect(problem).toMatchObject({ status: 400, code: 'invalid_token' });
  });

  it('answers invalid_current_password with 400 and the field error', async () => {
    const { problem } = await problemFor(new InvalidCurrentPassword());
    expect(problem).toMatchObject({
      status: 400,
      code: 'invalid_current_password',
      errors: [{ path: 'currentPassword' }],
    });
  });

  it.each([
    [new WeakPassword('too_short', 'newPassword'), 422, 'weak_password'],
    [new EmailAlreadyVerified(), 409, 'email_already_verified'],
  ])('leaves other errors alone (%s)', async (error, status, code) => {
    const { thrown, problem } = await problemFor(error);
    expect(thrown).toBe(error);
    expect(problem).toMatchObject({ status, code });
  });
});
