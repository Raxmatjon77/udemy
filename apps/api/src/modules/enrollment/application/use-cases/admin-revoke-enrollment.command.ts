import { Injectable } from '@nestjs/common';
import type { AdminEnrollment } from '@udemy/contracts';
import { EnrollmentNotFound, InvalidStateTransition } from '../../domain/enrollment.errors';
import { AdminEnrollmentAssembler } from '../admin-enrollment.assembler';
import { EnrollmentWriter } from '../enrollment-writer';
import { EnrollmentRepository } from '../ports/enrollment.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface AdminRevokeEnrollmentInput {
  readonly actorId: string;
  readonly enrollmentId: string;
  /** 10–2000 characters (audited on the transition). */
  readonly reason: string;
}

/**
 * `AdminRevokeEnrollment` (design §5): ACTIVE -> REVOKED with reason ADMIN, the admin as actor
 * and `EnrollmentRevoked` in the same transaction. The conditional update decides a race with
 * a concurrent revoke (exactly one wins; the other gets 409).
 *
 * Errors: 404 `enrollment_not_found`, 409 `invalid_state_transition` (not ACTIVE),
 * 422 `validation_failed` (reason).
 */
@Injectable()
export class AdminRevokeEnrollmentCommand {
  constructor(
    private readonly enrollments: EnrollmentRepository,
    private readonly writer: EnrollmentWriter,
    private readonly assembler: AdminEnrollmentAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: AdminRevokeEnrollmentInput): Promise<AdminEnrollment> {
    const revoked = await this.tx.run(async (trx) => {
      const current = await this.enrollments.findById(input.enrollmentId, trx);
      if (current === null) throw new EnrollmentNotFound();
      if (current.status !== 'ACTIVE')
        throw new InvalidStateTransition('The enrollment is already revoked.');
      const result = await this.writer.revoke(trx, {
        userId: current.userId,
        courseId: current.courseId,
        cause: 'ADMIN',
        actorId: input.actorId,
        reason: input.reason,
      });
      if (result.outcome !== 'REVOKED' || result.enrollment === null) {
        throw new InvalidStateTransition('The enrollment is already revoked.');
      }
      return result.enrollment;
    });
    return this.assembler.assembleOne(revoked);
  }
}
