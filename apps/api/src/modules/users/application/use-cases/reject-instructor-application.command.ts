import { Injectable } from '@nestjs/common';
import type { InstructorApplication as InstructorApplicationView } from '@udemy/contracts';
import { InstructorApplicationDecider } from '../instructor-application.decider';
import { InstructorApplicationEventPublisher } from '../ports/instructor-application-event.publisher';
import { TransactionRunner } from '../ports/transaction-runner';
import { toApplicationView } from '../views';

export interface RejectInstructorApplicationInput {
  readonly actorId: string;
  readonly applicationId: string;
  /** 10–1000 chars; mailed to the applicant. */
  readonly reason: string;
  readonly expectedVersion?: number;
}

/**
 * `RejectInstructorApplication` (design §5): like approve (one transaction, conditional
 * update, transition, outbox `InstructorApplicationRejected`) without a role grant.
 */
@Injectable()
export class RejectInstructorApplicationCommand {
  constructor(
    private readonly decider: InstructorApplicationDecider,
    private readonly events: InstructorApplicationEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: RejectInstructorApplicationInput): Promise<InstructorApplicationView> {
    return this.tx.run(async (trx) => {
      const { decision, occurredAt } = await this.decider.decide(
        trx,
        input.applicationId,
        input.expectedVersion,
        (application) => application.reject(input.actorId, input.reason),
      );
      if (decision.reason === null) throw new Error('A rejection always carries a reason');
      await this.events.rejected(trx, {
        applicationId: decision.applicationId,
        applicantId: decision.applicantId,
        decidedBy: input.actorId,
        reason: decision.reason,
        decidedAt: occurredAt.toISOString(),
      });
      return toApplicationView(await this.decider.load(trx, input.applicationId));
    });
  }
}
