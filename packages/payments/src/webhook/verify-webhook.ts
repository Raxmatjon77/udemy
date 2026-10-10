import { parseProviderEvent } from './normalize';
import type { ProviderEvent } from './provider-event';
import { DEFAULT_WEBHOOK_TOLERANCE_SECONDS, verifyWebhookSignature } from './signature';

/**
 * Verify, then parse and normalize. The body is parsed only AFTER the signature over its exact
 * bytes has verified, so a re-serialized (even semantically identical) body always fails.
 * Pure and synchronous: the api's `StripeSignatureGuard` and `InMemoryPaymentProvider` share it.
 */
export function verifyStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string | readonly string[] | undefined,
  secret: string,
  toleranceSeconds: number = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  now: Date = new Date(),
): ProviderEvent {
  verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSeconds, now);
  return parseProviderEvent(rawBody);
}
