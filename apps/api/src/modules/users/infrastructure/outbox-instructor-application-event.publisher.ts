import { Injectable } from '@nestjs/common';
import {
  InstructorApplicationApproved,
  type InstructorApplicationApprovedPayload,
  InstructorApplicationRejected,
  type InstructorApplicationRejectedPayload,
  InstructorApplicationSubmitted,
  type InstructorApplicationSubmittedPayload,
  InstructorApplicationWithdrawn,
  type InstructorApplicationWithdrawnPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { InstructorApplicationEventPublisher } from '../application/ports/instructor-application-event.publisher';

/** `users.instructor_application` events through the transactional outbox; key = applicationId. */
@Injectable()
export class OutboxInstructorApplicationEventPublisher extends InstructorApplicationEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async submitted(
    trx: Transaction<DB>,
    payload: InstructorApplicationSubmittedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, InstructorApplicationSubmitted, payload.applicationId, payload);
  }

  async approved(
    trx: Transaction<DB>,
    payload: InstructorApplicationApprovedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, InstructorApplicationApproved, payload.applicationId, payload);
  }

  async rejected(
    trx: Transaction<DB>,
    payload: InstructorApplicationRejectedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, InstructorApplicationRejected, payload.applicationId, payload);
  }

  async withdrawn(
    trx: Transaction<DB>,
    payload: InstructorApplicationWithdrawnPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, InstructorApplicationWithdrawn, payload.applicationId, payload);
  }
}
