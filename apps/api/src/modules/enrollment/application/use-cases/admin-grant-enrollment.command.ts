import { Injectable } from '@nestjs/common';
import type { AdminEnrollment } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { IdentityFacade } from '../../../identity';
import { AlreadyEnrolled, CourseNotFound, UserNotFound } from '../../domain/enrollment.errors';
import { AdminEnrollmentAssembler } from '../admin-enrollment.assembler';
import { EnrollmentWriter } from '../enrollment-writer';
import { TransactionRunner } from '../ports/transaction-runner';

export interface AdminGrantEnrollmentInput {
  readonly actorId: string;
  readonly userId: string;
  readonly courseId: string;
  /** 10–2000 characters (audited on the transition). */
  readonly reason: string;
}

/**
 * `AdminGrantEnrollment` (design §5): a support grant with source ADMIN, outside any order. A
 * REVOKED enrollment is re-granted. Any course with a live revision qualifies, archived ones
 * included (D13). `EnrollmentGranted` commits with it.
 *
 * Errors: 404 `user_not_found` / `course_not_found`, 409 `already_enrolled` (nothing written),
 * 422 `validation_failed` (reason).
 */
@Injectable()
export class AdminGrantEnrollmentCommand {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly catalog: CatalogFacade,
    private readonly writer: EnrollmentWriter,
    private readonly assembler: AdminEnrollmentAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: AdminGrantEnrollmentInput): Promise<AdminEnrollment> {
    if ((await this.identity.getUserSummary(input.userId)) === null) throw new UserNotFound();
    if ((await this.catalog.getPublishedCourse(input.courseId)) === null) {
      throw new CourseNotFound();
    }
    const enrollment = await this.tx.run(async (trx) => {
      const result = await this.writer.grant(trx, {
        userId: input.userId,
        courseId: input.courseId,
        source: 'ADMIN',
        actorId: input.actorId,
        reason: input.reason,
      });
      if (result.outcome === 'ALREADY_ACTIVE') throw new AlreadyEnrolled();
      return result.enrollment;
    });
    return this.assembler.assembleOne(enrollment);
  }
}
