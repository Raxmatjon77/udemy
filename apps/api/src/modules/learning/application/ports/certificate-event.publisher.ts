import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Certificate events (`learning.certificate`, aggregate id = **certificateId**, design §7)
 * through the transactional outbox, in the caller's transaction. The api writes only the ADMIN
 * `CertificateRevoked` / `CertificateReinstated`; issuing is the worker's.
 */
export abstract class CertificateEventPublisher {
  abstract publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly certificateId: string },
  ): Promise<void>;
}
