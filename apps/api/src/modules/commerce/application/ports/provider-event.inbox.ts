import type { ProviderEventOutcome } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

export interface ProviderEventClaim {
  /** `evt_…`, or the reconciler's synthetic `reconcile:{sessionId}:{COMPLETED|EXPIRED}`. */
  readonly eventId: string;
  /** The raw provider type (also for unhandled events). */
  readonly type: string;
  readonly livemode: boolean;
  /** Session / refund / dispute / charge id. */
  readonly objectId: string | null;
  readonly providerCreatedAt: Date;
  /** SHA-256 of the raw body (32 bytes); no payload is stored (PII). */
  readonly payloadSha256: Buffer;
}

/**
 * `commerce.provider_events`, the webhook inbox (D10, R6): claim, apply, outbox and outcome
 * happen in ONE transaction; a concurrent duplicate blocks on the PK and then sees a conflict.
 */
export abstract class ProviderEventInbox {
  /** `INSERT … ON CONFLICT DO NOTHING`: true = claimed by this transaction, false = duplicate. */
  abstract claim(trx: Transaction<DB>, event: ProviderEventClaim): Promise<boolean>;

  /** The single outcome update (processed_at, outcome, order_id NULL -> value). */
  abstract finish(
    trx: Transaction<DB>,
    eventId: string,
    outcome: ProviderEventOutcome,
    orderId: string | null,
  ): Promise<void>;
}
