import { randomUUID } from 'node:crypto';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { PROBLEM_JSON_CONTENT_TYPE, type ProblemDetails } from '@udemy/contracts';
import { REQUEST_ID_HEADER } from '@udemy/nest-common';
import { DependencyUnavailableError } from '@udemy/nest-common/errors';
import type { Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { RateLimitedError } from './rate-limited.error';
import { toProblemDetails } from './to-problem-details';

/** pino-http assigns `req.id`; it is the id we log, so it is the id we hand to clients. */
function traceIdOf(req: Request, res: Response): string {
  const id = (req as Request & { id?: string | number }).id;
  if (id !== undefined) return String(id);
  const header = res.getHeader(REQUEST_ID_HEADER);
  return typeof header === 'string' ? header : randomUUID();
}

/**
 * Global catch-all filter: every HTTP error leaves the app as `application/problem+json`
 * with a `traceId` that matches the request's log lines. 5xx are logged with the stack;
 * the stack reaches the client only outside production.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly config: AppConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // Only HTTP is served today. WebSocket/RPC contexts will get their own filters.
      throw exception;
    }
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const problem: ProblemDetails = {
      ...toProblemDetails(exception, { exposeInternals: !this.config.isProduction }),
      instance: req.originalUrl,
      traceId: traceIdOf(req, res),
    };

    this.log(exception, problem);

    if (res.headersSent) return;
    if (exception instanceof RateLimitedError) {
      res.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }
    res.status(problem.status).type(PROBLEM_JSON_CONTENT_TYPE).json(problem);
  }

  /**
   * Unexpected errors (bugs) -> ERROR with stack. An unavailable dependency (fail-closed 503)
   * -> ERROR with the dependency and cause: it is an outage, not a bug. Deliberate 5xx
   * HttpExceptions (e.g. a failing readiness probe) -> WARN. Client errors (4xx) -> DEBUG.
   */
  private log(exception: unknown, problem: ProblemDetails): void {
    if (problem.status < 500) {
      this.logger.debug({ problem }, 'Request rejected');
    } else if (exception instanceof DependencyUnavailableError) {
      this.logger.error(
        {
          err: exception.cause ?? exception,
          dependency: exception.dependency,
          traceId: problem.traceId,
        },
        'Dependency unavailable; request refused (fail-closed)',
      );
    } else if (exception instanceof HttpException) {
      this.logger.warn({ problem }, 'Request failed');
    } else {
      this.logger.error({ err: exception, traceId: problem.traceId }, 'Unhandled error');
    }
  }
}
