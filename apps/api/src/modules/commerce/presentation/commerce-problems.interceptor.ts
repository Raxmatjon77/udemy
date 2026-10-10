import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import {
  CartChanged,
  CheckoutInProgress,
  IdempotencyKeyRequired,
  PaymentProviderUnavailable,
  PriceChanged,
} from '../domain/commerce.errors';

/**
 * Commerce errors whose RFC 7807 body carries extension members, or whose status the shared
 * DomainError kinds lack (design §8 checkout row): they become HttpExceptions, and the global
 * problem-details filter keeps `code` and the extensions (`quote`, `orderId`, `checkoutUrl`).
 *
 * | error                        | status | extensions                         |
 * | ---------------------------- | ------ | ---------------------------------- |
 * | `idempotency_key_required`   | 400    | `errors`                           |
 * | `price_changed`              | 409    | `quote` (`PriceChangedProblem`)    |
 * | `cart_changed`               | 409    | `quote` (`CartChangedProblem`)     |
 * | `checkout_in_progress`       | 409    | `orderId`, `checkoutUrl`           |
 * | `payment_provider_unavailable` | 503  | none                               |
 */
@Injectable()
export class CommerceProblemsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const mapped = toHttpException(error);
        return throwError(() => mapped ?? error);
      }),
    );
  }
}

export function toHttpException(error: unknown): HttpException | undefined {
  if (error instanceof IdempotencyKeyRequired) {
    return new HttpException(
      { message: error.message, code: error.code, errors: error.issues },
      HttpStatus.BAD_REQUEST,
      { cause: error },
    );
  }
  if (error instanceof PriceChanged || error instanceof CartChanged) {
    return new HttpException(
      { message: error.message, code: error.code, quote: error.quote },
      HttpStatus.CONFLICT,
      { cause: error },
    );
  }
  if (error instanceof CheckoutInProgress) {
    return new HttpException(
      {
        message: error.message,
        code: error.code,
        orderId: error.orderId,
        checkoutUrl: error.checkoutUrl,
      },
      HttpStatus.CONFLICT,
      { cause: error },
    );
  }
  if (error instanceof PaymentProviderUnavailable) {
    return new HttpException(
      { message: error.message, code: error.code },
      HttpStatus.SERVICE_UNAVAILABLE,
      { cause: error },
    );
  }
  return undefined;
}
