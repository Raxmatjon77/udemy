/**
 * Webhook inbox (docs/phase-4-schema-design.md D10, §8.3 steps 0 and 9, race R6).
 *
 * Claim, apply, outbox and outcome happen in ONE transaction. A concurrent duplicate blocks on
 * `provider_events_pk` until the first commits and then sees the conflict (claimed = false ->
 * 200 without effects); if the first rolls back, the second proceeds. No payload is stored (PII).
 */
import { sql } from 'kysely';
import { assertNonEmptyText, assertOneOf } from '../internal/assert';
import type { Executor } from '../transaction';

export const PROVIDER_EVENT_OUTCOMES = [
  'APPLIED',
  'DUPLICATE_EFFECT',
  'IGNORED',
  'ORPHAN',
  'MISMATCH',
] as const;
export type ProviderEventOutcome = (typeof PROVIDER_EVENT_OUTCOMES)[number];

export interface ClaimProviderEventInput {
  /** `evt_...`, or the reconciler's synthetic `reconcile:{sessionId}:{COMPLETED|EXPIRED}`. */
  eventId: string;
  type: string;
  livemode: boolean;
  /** Session / refund / dispute id. */
  objectId: string | null;
  providerCreatedAt: Date;
  /** SHA-256 of the raw body (32 bytes). */
  payloadSha256: Buffer;
}

/** `INSERT ... ON CONFLICT DO NOTHING`: true = claimed by this transaction, false = duplicate. */
export async function claimProviderEvent(
  executor: Executor,
  input: ClaimProviderEventInput,
): Promise<boolean> {
  assertNonEmptyText('eventId', input.eventId, 255);
  const { rows } = await sql<{ eventId: string }>`
    INSERT INTO commerce.provider_events
      (provider, event_id, type, livemode, object_id, order_id, provider_created_at, payload_sha256)
    VALUES ('STRIPE', ${input.eventId}, ${input.type}, ${input.livemode}, ${input.objectId}, NULL,
            ${input.providerCreatedAt}, ${input.payloadSha256})
    ON CONFLICT (provider, event_id) DO NOTHING
    RETURNING event_id
  `.execute(executor);
  return rows.length === 1;
}

export interface FinishProviderEventInput {
  eventId: string;
  outcome: ProviderEventOutcome;
  /** The mapped order (NULL -> value only; provider_events_guard_trg). */
  orderId?: string | null;
}

/**
 * The single outcome update (provider_events_guard_trg allows exactly one). false = already
 * finished (or not claimed); a second finish attempt that changes columns would be 42501.
 */
export async function finishProviderEvent(
  executor: Executor,
  input: FinishProviderEventInput,
): Promise<boolean> {
  assertOneOf('outcome', input.outcome, PROVIDER_EVENT_OUTCOMES);
  const result = await sql`
    UPDATE commerce.provider_events
       SET order_id = coalesce(order_id, ${input.orderId ?? null}::uuid), processed_at = now(), outcome = ${input.outcome}
     WHERE provider = 'STRIPE' AND event_id = ${input.eventId} AND processed_at IS NULL
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0) === 1;
}
