import { Injectable } from '@nestjs/common';
import type { AdminUserEnrollments } from '@udemy/contracts';
import { IdentityFacade } from '../../../identity';
import { UserNotFound } from '../../domain/enrollment.errors';
import { AdminEnrollmentAssembler } from '../admin-enrollment.assembler';
import { EnrollmentRepository } from '../ports/enrollment.repository';

/**
 * `AdminListUserEnrollments` (design §5, admin user detail "Enrollments" tab): every enrollment
 * of the user, ACTIVE and REVOKED, newest grant first, with source, course and transitions.
 *
 * Errors: 404 `user_not_found`.
 */
@Injectable()
export class AdminListUserEnrollmentsQuery {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly enrollments: EnrollmentRepository,
    private readonly assembler: AdminEnrollmentAssembler,
  ) {}

  async execute(userId: string): Promise<AdminUserEnrollments> {
    if ((await this.identity.getUserSummary(userId)) === null) throw new UserNotFound();
    const rows = await this.enrollments.listByUser(userId);
    return { items: await this.assembler.assemble(rows) };
  }
}
