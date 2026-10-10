import { createHash } from 'node:crypto';
import type { ProviderCheckoutSession, ProviderEvent } from '@udemy/payments';

export type SyntheticStatus = 'COMPLETED' | 'EXPIRED';

export interface SyntheticEvent {
  readonly event: ProviderEvent;
  readonly payloadSha256: Buffer;
}

/**
 * The reconciler's view of a retrieved Checkout Session as a provider event (schema doc §8.5,
 * R2): id `reconcile:{sessionId}:{COMPLETED|EXPIRED}`, claimed in `commerce.provider_events`
 * like a real one, and applied through the SAME `HandleProviderEvent` path. Its digest covers
 * the fields the handler reads (no PII).
 */
export function syntheticCheckoutEvent(
  session: ProviderCheckoutSession,
  status: SyntheticStatus,
  now: Date,
): SyntheticEvent {
  const id = `reconcile:${session.sessionId}:${status}`;
  const base = { orderId: session.orderId, clientReferenceId: session.clientReferenceId };
  const event: ProviderEvent =
    status === 'COMPLETED'
      ? {
          id,
          providerType: 'checkout.session.completed',
          createdAt: now,
          livemode: session.livemode,
          apiVersion: null,
          data: {
            type: 'checkout.session.completed',
            sessionId: session.sessionId,
            ...base,
            paymentStatus: session.paymentStatus,
            paymentIntentId: session.paymentIntentId,
            amountTotalMinor: session.amountTotalMinor,
            currency: session.currency,
          },
        }
      : {
          id,
          providerType: 'checkout.session.expired',
          createdAt: now,
          livemode: session.livemode,
          apiVersion: null,
          data: { type: 'checkout.session.expired', sessionId: session.sessionId, ...base },
        };
  const payloadSha256 = createHash('sha256').update(JSON.stringify(event), 'utf8').digest();
  return { event, payloadSha256 };
}
