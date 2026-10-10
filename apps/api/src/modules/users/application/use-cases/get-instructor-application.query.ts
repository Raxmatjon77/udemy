import { Injectable } from '@nestjs/common';
import type { InstructorApplicationDetail } from '@udemy/contracts';
import type { AuthorizationSubject } from '../../../access';
import { IdentityFacade } from '../../../identity';
import { InstructorApplicationNotFound } from '../../domain/users.errors';
import { InstructorApplicationRepository } from '../ports/instructor-application.repository';
import { toApplicationDetail } from '../views';

export interface GetInstructorApplicationInput {
  readonly principal: AuthorizationSubject;
  readonly applicationId: string;
}

/**
 * `GetInstructorApplication` (design §5): the application, its transitions and the applicant
 * summary. `@CheckPolicy` already allowed the caller (own or any); the use case re-checks it
 * (defence in depth) and answers 404 for a foreign application, like the guard.
 */
@Injectable()
export class GetInstructorApplicationQuery {
  constructor(
    private readonly applications: InstructorApplicationRepository,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: GetInstructorApplicationInput): Promise<InstructorApplicationDetail> {
    const application = await this.applications.findById(input.applicationId);
    if (application === null) throw new InstructorApplicationNotFound();
    const mayReadAny = input.principal.permissions.has('instructor_application:read:any');
    if (!mayReadAny && application.applicantId !== input.principal.userId) {
      throw new InstructorApplicationNotFound();
    }
    const applicant = await this.identity.getUserSummary(application.applicantId);
    if (applicant === null) throw new InstructorApplicationNotFound();
    return toApplicationDetail(application, applicant);
  }
}
