import type {
  InstructorApplicationApprovedPayload,
  InstructorApplicationRejectedPayload,
  InstructorApplicationSubmittedPayload,
  InstructorApplicationWithdrawnPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Port for the `users.instructor_application` outbox events (aggregateId = applicationId).
 * Every method writes inside the caller's transaction.
 */
export abstract class InstructorApplicationEventPublisher {
  abstract submitted(
    trx: Transaction<DB>,
    payload: InstructorApplicationSubmittedPayload,
  ): Promise<void>;
  abstract approved(
    trx: Transaction<DB>,
    payload: InstructorApplicationApprovedPayload,
  ): Promise<void>;
  abstract rejected(
    trx: Transaction<DB>,
    payload: InstructorApplicationRejectedPayload,
  ): Promise<void>;
  abstract withdrawn(
    trx: Transaction<DB>,
    payload: InstructorApplicationWithdrawnPayload,
  ): Promise<void>;
}
