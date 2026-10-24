import {
  type CallHandler,
  type ExecutionContext,
  type HttpException,
  Injectable,
  type NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { AnnouncementLimitExceeded, MarkdownNotAllowed } from '../domain/engagement.errors';

/**
 * Engagement errors whose RFC 7807 body carries extension members (the commerce/catalog
 * technique): they become HttpExceptions, and the global problem-details filter keeps `code`
 * and the extra members.
 *
 * | error                         | status | extensions                                      |
 * | ----------------------------- | ------ | ----------------------------------------------- |
 * | `markdown_not_allowed`        | 422    | `errors`, `issues` (`MarkdownNotAllowedProblem`) |
 * | `announcement_limit_exceeded` | 422    | `retryAt` (`AnnouncementLimitProblem`)          |
 */
@Injectable()
export class EngagementProblemsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(catchError((error: unknown) => throwError(() => toEngagementProblem(error) ?? error)));
  }
}

export function toEngagementProblem(error: unknown): HttpException | undefined {
  if (error instanceof MarkdownNotAllowed) {
    return new UnprocessableEntityException(
      {
        message: error.message,
        code: error.code,
        errors: [...error.issues],
        issues: [...error.markdownIssues],
      },
      { cause: error },
    );
  }
  if (error instanceof AnnouncementLimitExceeded) {
    return new UnprocessableEntityException(
      { message: error.message, code: error.code, retryAt: error.retryAt.toISOString() },
      { cause: error },
    );
  }
  return undefined;
}
