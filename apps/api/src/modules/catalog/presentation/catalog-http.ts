import { UnprocessableEntityException } from '@nestjs/common';
import { ErrorCode } from '@udemy/contracts';
import type { Request } from 'express';
import { CourseNotReady } from '../domain/catalog.errors';

/** Absolute path of a course (the `Location` of a 201), as the BFFs see it. */
export function courseLocation(courseId: string): string {
  return `/api/v1/courses/${courseId}`;
}

/**
 * The `:courseId` route param for `@CheckPolicy({ resource: 'course', ... })`. Nested section
 * and lecture routes are authorised through their course only (design Q7); the use cases load
 * the child scoped by this course id.
 */
export const courseIdOf = (req: Request): string => String(req.params.courseId);

/**
 * Runs a use case and turns `CourseNotReady` into the contract's `CourseNotReadyProblem`
 * (422 + `issues[]` of readiness issues): the global filter keeps the extra members of an
 * HttpException body as RFC 7807 extension members (the same technique as media's
 * `withUploadProblems`). A DomainError's `issues` would be rendered as field `errors` instead.
 */
export async function withSubmitProblems<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CourseNotReady) {
      throw new UnprocessableEntityException(
        {
          message: error.message,
          code: ErrorCode.CourseNotReady,
          issues: [...error.readinessIssues],
        },
        { cause: error },
      );
    }
    throw error;
  }
}
