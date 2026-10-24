import { Injectable } from '@nestjs/common';
import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { CertificateEventPublisher } from '../application/ports/certificate-event.publisher';

/** `learning.certificate` events through the transactional outbox; key = certificateId (§7). */
@Injectable()
export class OutboxCertificateEventPublisher extends CertificateEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly certificateId: string },
  ): Promise<void> {
    await this.outbox.publish(trx, event, payload.certificateId, payload);
  }
}
