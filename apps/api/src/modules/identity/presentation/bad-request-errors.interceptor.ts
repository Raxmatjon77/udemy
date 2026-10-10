import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { InvalidCurrentPassword, InvalidOneTimeToken } from '../domain/identity.errors';

/**
 * Design §8 answers `invalid_token` and `invalid_current_password` with **400**, but the
 * shared DomainError kinds have no 400 (`validation` is 422). This interceptor turns exactly
 * those two errors into a 400 HttpException; the global problem-details filter keeps `code`
 * (and `errors`) as extension members, so the body is the usual `application/problem+json`.
 */
@Injectable()
export class BadRequestErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof InvalidOneTimeToken || error instanceof InvalidCurrentPassword) {
          const body: Record<string, unknown> = { message: error.message, code: error.code };
          if (error.issues.length > 0) body.errors = error.issues;
          return throwError(
            () => new HttpException(body, HttpStatus.BAD_REQUEST, { cause: error }),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
