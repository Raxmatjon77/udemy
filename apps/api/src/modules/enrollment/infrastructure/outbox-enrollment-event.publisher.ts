import { Injectable } from '@nestjs/common';
import {
  EnrollmentGranted,
  type EnrollmentGrantedPayload,
  EnrollmentRevoked,
  type EnrollmentRevokedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { EnrollmentEventPublisher } from '../application/ports/enrollment-event.publisher';

/** `enrollment.enrollment` events through the transactional outbox; key = enrollmentId. */
@Injectable()
export class OutboxEnrollmentEventPublisher extends EnrollmentEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async granted(trx: Transaction<DB>, payload: EnrollmentGrantedPayload): Promise<void> {
    await this.outbox.publish(trx, EnrollmentGranted, payload.enrollmentId, payload);
  }

  async revoked(trx: Transaction<DB>, payload: EnrollmentRevokedPayload): Promise<void> {
    await this.outbox.publish(trx, EnrollmentRevoked, payload.enrollmentId, payload);
  }
}
