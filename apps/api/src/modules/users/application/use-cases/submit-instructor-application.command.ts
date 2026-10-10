import { Injectable } from '@nestjs/common';
import type { InstructorApplication as InstructorApplicationView } from '@udemy/contracts';
import { AccessFacade } from '../../../access';
import { IdentityFacade } from '../../../identity';
import { type ApplicationForm, InstructorApplication } from '../../domain/instructor-application';
import {
  AlreadyInstructor,
  ApplicantBanned,
  ApplicationAlreadyPending,
  EmailNotVerified,
} from '../../domain/users.errors';
import { InstructorApplicationDecider } from '../instructor-application.decider';
import { InstructorApplicationEventPublisher } from '../ports/instructor-application-event.publisher';
import { InstructorApplicationRepository } from '../ports/instructor-application.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toApplicationView } from '../views';

export interface SubmitInstructorApplicationInput {
  readonly applicantId: string;
  readonly form: ApplicationForm;
}

/**
 * `SubmitInstructorApplication` (design §5). Eligibility is checked from fresh state, never
 * from the token: not banned (403 `account_banned`), verified email (403 `email_not_verified`),
 * not an instructor (409 `already_instructor`), no other PENDING application (409
 * `application_already_pending`; a concurrent submit loses on the partial unique index and
 * gets the same error). The application, its submission transition (`from_status` NULL) and
 * `InstructorApplicationSubmitted` commit together.
 */
@Injectable()
export class SubmitInstructorApplicationCommand {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
    private readonly applications: InstructorApplicationRepository,
    private readonly decider: InstructorApplicationDecider,
    private readonly events: InstructorApplicationEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: SubmitInstructorApplicationInput): Promise<InstructorApplicationView> {
    const submission = InstructorApplication.submit(input.applicantId, input.form);
    return this.tx.run(async (trx) => {
      const account = await this.identity.getAccountStatus(input.applicantId, trx);
      if (account.status === 'BANNED') throw new ApplicantBanned();
      if (!(await this.identity.isEmailVerified(input.applicantId, trx))) {
        throw new EmailNotVerified();
      }
      if (await this.access.hasRole(input.applicantId, 'INSTRUCTOR', trx)) {
        throw new AlreadyInstructor();
      }
      if (await this.applications.hasPending(input.applicantId, trx)) {
        throw new ApplicationAlreadyPending();
      }

      const { id } = await this.applications.insert(trx, submission);
      const created = await this.decider.load(trx, id);
      await this.events.submitted(trx, {
        applicationId: id,
        applicantId: input.applicantId,
        submittedAt: created.submittedAt.toISOString(),
      });
      return toApplicationView(created);
    });
  }
}
