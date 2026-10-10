import { z } from 'zod';
import { type OwnershipResolver, OwnershipResolverFor } from '../../../shared/auth';
import { InstructorApplicationRepository } from './ports/instructor-application.repository';

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/**
 * Ownership of instructor applications for `@CheckPolicy({ resource: 'instructor_application' })`
 * with `:own` permissions (discovered by the access module's OwnershipRegistry). The guard runs
 * before the param pipes, so a malformed id must answer "does not exist" (404), not reach
 * Postgres as an invalid uuid (500).
 */
@OwnershipResolverFor('instructor_application')
export class InstructorApplicationOwnership implements OwnershipResolver {
  constructor(private readonly applications: InstructorApplicationRepository) {}

  async ownerOf(resourceId: string): Promise<string | null> {
    if (!isUuid(resourceId)) return null;
    return this.applications.findApplicantId(resourceId);
  }
}
