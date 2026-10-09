import { StandardSchemaValidationPipe } from '@nestjs/common';
import { RequestValidationException } from '../errors/request-validation.exception';

/**
 * Nest 12 validates natively against any Standard Schema (zod 4 is one), so we need
 * neither nestjs-zod nor class-validator. Attach the schema on the parameter:
 *
 *   @Post()
 *   create(@Body({ schema: CreateCourseSchema }) body: CreateCourseInput) {}
 *
 * Parameters without a schema pass through untouched. Valid input is replaced by the
 * schema's output (defaults/transforms applied); invalid input becomes a 400 problem+json.
 * @nestjs/swagger 12 also reads the schema (via zod's `~standard.jsonSchema`) for the docs.
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new RequestValidationException(
        issues.map((issue) => ({
          path: (issue.path ?? [])
            .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
            .join('.'),
          message: issue.message,
        })),
      ),
  });
}
