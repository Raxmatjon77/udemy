import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { InvalidUnsubscribeToken } from '../domain/notifications.errors';

/**
 * Design §5 answers `invalid_unsubscribe_token` with **400**, but the shared DomainError kinds
 * have no 400 (`validation` is 422). This turns exactly that error into a 400 HttpException; the
 * global problem-details filter keeps `code`, so the body is the usual problem+json.
 */
@Injectable()
export class UnsubscribeErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof InvalidUnsubscribeToken) {
          return throwError(
            () =>
              new HttpException(
                { message: error.message, code: error.code },
                HttpStatus.BAD_REQUEST,
                { cause: error },
              ),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
