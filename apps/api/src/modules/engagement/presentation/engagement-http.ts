import type { Request } from 'express';

/**
 * The `:courseId` route param for `@CheckPolicy({ resource: 'course', action: 'engage' })`
 * (catalog's `CourseOwnership`: the owner of a non-deleted course; 404 otherwise). Instructor
 * engagement routes are nested under the course; reviews are then resolved within it (IDOR).
 */
export const courseIdOf = (req: Request): string => String(req.params.courseId);
