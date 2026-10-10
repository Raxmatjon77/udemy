import { randomBytes } from 'node:crypto';
import { computeWebhookSignature, SIGNATURE_SCHEME } from '../webhook/signature.js';

export interface SignTestWebhookOptions {
  /**
   * Extra `v1=` values to put BEFORE the real one (e.g. a signature by an old, rolled secret), to
   * exercise "multiple v1 signatures, one valid".
   */
  readonly extraSignatures?: readonly string[];
  /** Also sign with these secrets (secret rolling: Stripe signs with every active secret). */
  readonly additionalSecrets?: readonly string[];
}

function toSeconds(timestamp: number | Date | undefined): number {
  if (timestamp === undefined) return Math.floor(Date.now() / 1000);
  if (timestamp instanceof Date) return Math.floor(timestamp.getTime() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError('timestamp must be unix SECONDS (an integer) or a Date');
  }
  return timestamp;
}

/**
 * Produces a valid `Stripe-Signature` header for EXACTLY these bytes (real HMAC-SHA256, the same
 * computation Stripe and `verifyWebhookSignature` use): `t={timestamp},v1={hex}`.
 * Send the same `payload` bytes you signed; re-serializing it will (correctly) fail verification.
 *
 * @param timestamp unix seconds or a Date; default now.
 */
export function signTestWebhook(
  payload: string | Buffer,
  secret: string,
  timestamp?: number | Date,
  options: SignTestWebhookOptions = {},
): string {
  const t = toSeconds(timestamp);
  const signatures = [
    ...(options.extraSignatures ?? []),
    computeWebhookSignature(payload, secret, t),
    ...(options.additionalSecrets ?? []).map((other) => computeWebhookSignature(payload, other, t)),
  ];
  return [`t=${t}`, ...signatures.map((signature) => `${SIGNATURE_SCHEME}=${signature}`)].join(',');
}

export interface SignedWebhookRequest {
  /** The exact bytes to POST. */
  readonly body: Buffer;
  readonly headers: {
    readonly 'content-type': 'application/json';
    readonly 'stripe-signature': string;
  };
}

/** Serializes an event ONCE and signs those bytes: what the emulator and e2e tests POST. */
export function signedWebhookRequest(
  event: unknown,
  secret: string,
  timestamp?: number | Date,
): SignedWebhookRequest {
  const body = Buffer.from(JSON.stringify(event), 'utf8');
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signTestWebhook(body, secret, timestamp),
    },
  };
}

/** An ephemeral `whsec_…` secret (design D12 layer 4: one per CI run / test file). */
export function randomWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}
