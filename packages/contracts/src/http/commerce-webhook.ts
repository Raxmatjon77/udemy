import { z } from 'zod';

/* ----------------------------------------------------------------------------------------
 * POST /api/v1/webhooks/stripe (public ingress, never through a BFF; design D10, §8, §9)
 *
 * Markers: `@StripeWebhook()` = `@Public() @NoClientAuth() @WebhookIngress('stripe')
 * @UseGuards(StripeSignatureGuard) @SkipThrottle() @HttpCode(200)`, tag `webhooks` (excluded
 * from api-client generation).
 *
 * **The request body is the raw Stripe JSON and has no contract schema on purpose.** The
 * guard verifies the signature over the exact bytes (`req.rawBody`, a Buffer); the handler
 * never reads `@Body()`, and nothing may parse, re-serialize or transform the body before the
 * guard (re-serialized JSON with identical content must fail verification). Only the
 * `Stripe-Signature` header is described here.
 *
 * Responses:
 *   200 `{ received: true }`: applied, and also for duplicates, ignored and orphan events.
 *   400 `webhook_signature_invalid` (problem+json with no detail): missing raw body or a
 *       missing, malformed, stale (> 300 s) or wrong signature.
 *   500: an unexpected failure; the transaction rolled back and Stripe retries (up to 3 days).
 * -------------------------------------------------------------------------------------- */

export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe';

/** Header name, lowercase as Node exposes it. Redacted from logs. */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/** Signature timestamp tolerance (`STRIPE_WEBHOOK_TOLERANCE_S` default). */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * The only described part of the request. Shape-checked loosely (`t=…,v1=…`); the guard is
 * the authority and answers 400 `webhook_signature_invalid` on any failure.
 */
export const StripeWebhookHeadersSchema = z.object({
  [STRIPE_SIGNATURE_HEADER]: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^t=\d+,/, 'Malformed signature'),
});
export type StripeWebhookHeaders = z.output<typeof StripeWebhookHeadersSchema>;

export const WebhookAckSchema = z.object({ received: z.literal(true) });
export type WebhookAck = z.infer<typeof WebhookAckSchema>;
