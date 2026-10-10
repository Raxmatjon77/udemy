import { HttpException } from '@nestjs/common';
import { type CartQuote, ErrorCode } from '@udemy/contracts';
import { lastValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { toProblemDetails } from '../../../shared/errors';
import {
  CartChanged,
  CartEmpty,
  CheckoutInProgress,
  IdempotencyKeyRequired,
  PaymentProviderUnavailable,
  PriceChanged,
} from '../domain/commerce.errors';
import { CommerceProblemsInterceptor, toHttpException } from './commerce-problems.interceptor';

const quote = { fingerprint: 'f' } as unknown as CartQuote;
const problem = (error: Error) =>
  toProblemDetails(toHttpException(error) ?? error, { exposeInternals: false });

describe('CommerceProblemsInterceptor', () => {
  it('400 idempotency_key_required with the field issue', () => {
    expect(problem(new IdempotencyKeyRequired())).toMatchObject({
      status: 400,
      code: ErrorCode.IdempotencyKeyRequired,
      errors: [{ path: 'idempotency-key' }],
    });
  });

  it('409 price_changed / cart_changed carry the fresh quote', () => {
    expect(problem(new PriceChanged(quote))).toMatchObject({
      status: 409,
      code: ErrorCode.PriceChanged,
      quote,
    });
    expect(problem(new CartChanged(quote))).toMatchObject({
      status: 409,
      code: ErrorCode.CartChanged,
      quote,
    });
  });

  it('409 checkout_in_progress carries orderId and checkoutUrl (null while CREATING)', () => {
    expect(problem(new CheckoutInProgress('o-1', null))).toMatchObject({
      status: 409,
      code: ErrorCode.CheckoutInProgress,
      orderId: 'o-1',
      checkoutUrl: null,
    });
  });

  it('503 payment_provider_unavailable; other errors pass through unchanged', async () => {
    expect(problem(new PaymentProviderUnavailable())).toMatchObject({
      status: 503,
      code: ErrorCode.PaymentProviderUnavailable,
    });
    expect(toHttpException(new CartEmpty())).toBeUndefined();
    const interceptor = new CommerceProblemsInterceptor();
    const passthrough = new CartEmpty();
    await expect(
      lastValueFrom(
        interceptor.intercept({} as never, { handle: () => throwError(() => passthrough) }),
      ),
    ).rejects.toBe(passthrough);
    await expect(
      lastValueFrom(
        interceptor.intercept({} as never, {
          handle: () => throwError(() => new PaymentProviderUnavailable()),
        }),
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
