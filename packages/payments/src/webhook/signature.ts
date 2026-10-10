import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureInvalidError } from '../errors';

/** Stripe's default and our configured tolerance (design §9): 300 s. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The only scheme Stripe signs live events with. `v0` (test-only legacy) is ignored. */
export const SIGNATURE_SCHEME = 'v1';

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const UNIX_SECONDS = /^\d{1,12}$/;

export interface ParsedSignatureHeader {
  /** Unix seconds. */
  readonly timestamp: number;
  /** Every `v1=` value, in header order (Stripe sends several while a secret is being rolled). */
  readonly signatures: readonly string[];
}

/**
 * HMAC-SHA256 over `"{t}." + rawBody` keyed with the WHOLE secret string (including `whsec_`),
 * hex-encoded: exactly what Stripe computes. Hashes the bytes as received; never re-encodes them.
 */
export function computeWebhookSignature(
  rawBody: Buffer | string,
  secret: string,
  timestamp: number,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
}

/** Parses `t=…,v1=…[,v1=…][,v0=…]`. Unknown keys are ignored; duplicate `t` is malformed. */
export function parseSignatureHeader(header: string): ParsedSignatureHeader {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== undefined || !UNIX_SECONDS.test(value)) {
        throw new WebhookSignatureInvalidError('malformed_header');
      }
      timestamp = Number(value);
    } else if (key === SIGNATURE_SCHEME) {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookSignatureInvalidError('malformed_header');
  }
  return { timestamp, signatures };
}

function singleHeader(header: string | readonly string[] | undefined): string {
  if (header === undefined) throw new WebhookSignatureInvalidError('missing_header');
  if (typeof header !== 'string') {
    // Node joins repeated headers for most names, but never trust an array here.
    if (header.length !== 1 || header[0] === undefined) {
      throw new WebhookSignatureInvalidError(
        header.length === 0 ? 'missing_header' : 'malformed_header',
      );
    }
    return singleHeader(header[0]);
  }
  if (header.trim() === '') throw new WebhookSignatureInvalidError('missing_header');
  return header;
}

function matches(expectedHex: string, candidate: string): boolean {
  if (!HEX_SHA256.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(candidate, 'hex'));
}

/**
 * Verifies a `Stripe-Signature` header against the raw body. Passes when ANY `v1` signature
 * matches (secret rolling), and the timestamp is within `toleranceSeconds` of `now` in EITHER
 * direction (Stripe only checks the past; a far-future `t` is rejected too, as clock-skew defence).
 * Returns the signed timestamp. Throws `WebhookSignatureInvalidError`.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | readonly string[] | undefined,
  secret: string,
  toleranceSeconds: number = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  now: Date = new Date(),
): number {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new WebhookSignatureInvalidError('missing_secret');
  }
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0) {
    // 0 would mean "skip the replay window" in stripe-node; we never allow that.
    throw new RangeError(`toleranceSeconds must be > 0, got ${toleranceSeconds}`);
  }
  if (!Buffer.isBuffer(rawBody)) {
    // A parsed object here means the raw-body plumbing is broken; fail closed.
    throw new WebhookSignatureInvalidError('invalid_payload');
  }
  const { timestamp, signatures } = parseSignatureHeader(singleHeader(signatureHeader));
  const expected = computeWebhookSignature(rawBody, secret, timestamp);
  // Compare against every candidate (no early exit) so timing does not reveal which one matched.
  let found = false;
  for (const candidate of signatures) {
    if (matches(expected, candidate)) found = true;
  }
  if (!found) throw new WebhookSignatureInvalidError('no_matching_signature');

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureInvalidError('timestamp_outside_tolerance');
  }
  return timestamp;
}
