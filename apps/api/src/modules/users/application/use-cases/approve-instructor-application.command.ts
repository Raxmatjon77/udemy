import { Injectable } from '@nestjs/common';
import type { InstructorApplication as InstructorApplicationView } from '@udemy/contracts';
import { AccessFacade } from '../../../access';
import { InstructorApplicationDecider } from '../instructor-application.decider';
import { InstructorApplicationEventPublisher } from '../ports/instructor-application-event.publisher';
import { TransactionRunner } from '../ports/transaction-runner';
import { toApplicationView } from '../views';

export interface ApproveInstructorApplicationInput {
  readonly actorId: string;
  readonly applicationId: string;
  /** Optional admin note, stored as the transition reason (1–1000 chars). */
  readonly note?: string;
  /** When given and stale: 409 `version_conflict`. */
  readonly expectedVersion?: number;
}

export const APPROVAL_GRANT_REASON = 'Instructor application approved';

/**
 * `ApproveInstructorApplication` (design §5), ONE transaction:
 *
 * 1. conditional `UPDATE ... SET status = 'APPROVED' WHERE status = 'PENDING' [AND version = ?]`
 * 2. the transition row
 * 3. `AccessFacade.grantRole(trx, INSTRUCTOR, source { type: 'instructor_application', id })`
 * 4. outbox `InstructorApplicationApproved`
 *
 * Errors: 404, 409 `invalid_state_transition` / `version_conflict`, 403
 * `self_decision_forbidden` (domain check, backed by `ia_transitions_actor_ck`).
 */
@Injectable()
export class ApproveInstructorApplicationCommand {
  constructor(
    private readonly decider: InstructorApplicationDecider,
    private readonly access: AccessFacade,
    private readonly events: InstructorApplicationEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: ApproveInstructorApplicationInput): Promise<InstructorApplicationView> {
    return this.tx.run(async (trx) => {
      const { decision, occurredAt } = await this.decider.decide(
        trx,
        input.applicationId,
        input.expectedVersion,
        (application) => application.approve(input.actorId, input.note),
      );
      await this.access.grantRole(trx, {
        userId: decision.applicantId,
        role: 'INSTRUCTOR',
        actorId: input.actorId,
        reason: APPROVAL_GRANT_REASON,
        source: { type: 'instructor_application', id: decision.applicationId },
      });
      await this.events.approved(trx, {
        applicationId: decision.applicationId,
        applicantId: decision.applicantId,
        decidedBy: input.actorId,
        decidedAt: occurredAt.toISOString(),
      });
      return toApplicationView(await this.decider.load(trx, input.applicationId));
    });
  }
}
