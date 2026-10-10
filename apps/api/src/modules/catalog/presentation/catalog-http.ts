import type { Request } from 'express';

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
