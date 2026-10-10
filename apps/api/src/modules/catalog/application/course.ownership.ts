import { z } from 'zod';
import { type OwnershipResolver, OwnershipResolverFor } from '../../../shared/auth';
import { CourseRepository } from './ports/course.repository';

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/**
 * Ownership of courses for `@CheckPolicy({ resource: 'course' })` with `:own` permissions
 * (design §3, D9): the owner of a NON-deleted course. Sections and lectures have no resolver of
 * their own (Q7): their routes are nested under `/courses/:courseId`, this resolver checks the
 * course, and every use case loads the child scoped by that course (a foreign child is 404).
 *
 * The guard runs before the param pipes, so a malformed id answers "does not exist" (404).
 */
@OwnershipResolverFor('course')
export class CourseOwnership implements OwnershipResolver {
  constructor(private readonly courses: CourseRepository) {}

  async ownerOf(resourceId: string): Promise<string | null> {
    if (!isUuid(resourceId)) return null;
    return this.courses.findOwnerId(resourceId);
  }
}
