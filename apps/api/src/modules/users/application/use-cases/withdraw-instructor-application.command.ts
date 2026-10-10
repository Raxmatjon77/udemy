import { Injectable } from '@nestjs/common';
import type { InstructorApplication as InstructorApplicationView } from '@udemy/contracts';
import { InstructorApplicationDecider } from '../instructor-application.decider';
import { InstructorApplicationEventPublisher } from '../ports/instructor-application-event.publisher';
import { TransactionRunner } from '../ports/transaction-runner';
import { toApplicationView } from '../views';

export interface WithdrawInstructorApplicationInput {
  readonly actorId: string;
  readonly applicationId: string;
}

/**
 * `WithdrawInstructorApplication` (design §5): PENDING -> WITHDRAWN by the applicant only
 * (anyone else: 404). 409 `invalid_state_transition` once decided.
 */
@Injectable()
export class WithdrawInstructorApplicationCommand {
  constructor(
    private readonly decider: InstructorApplicationDecider,
    private readonly events: InstructorApplicationEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: WithdrawInstructorApplicationInput): Promise<InstructorApplicationView> {
    return this.tx.run(async (trx) => {
      const { decision, occurredAt } = await this.decider.decide(
        trx,
        input.applicationId,
        undefined,
        (application) => application.withdraw(input.actorId),
      );
      await this.events.withdrawn(trx, {
        applicationId: decision.applicationId,
        applicantId: decision.applicantId,
        withdrawnAt: occurredAt.toISOString(),
      });
      return toApplicationView(await this.decider.load(trx, input.applicationId));
    });
  }
}
