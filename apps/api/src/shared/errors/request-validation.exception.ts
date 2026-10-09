import { BadRequestException } from '@nestjs/common';
import type { ProblemFieldError } from '@udemy/contracts';

/** Thrown by the global validation pipe when a request body/query/param fails its schema. */
export class RequestValidationException extends BadRequestException {
  constructor(readonly errors: readonly ProblemFieldError[]) {
    super('Request validation failed');
  }
}
