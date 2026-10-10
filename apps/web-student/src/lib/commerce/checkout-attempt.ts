import { IdempotencyKeySchema } from '@udemy/contracts';
import { z } from 'zod';

/**
 * The `Idempotency-Key` of a checkout attempt (Phase 4 §5 Checkout, §10).
 *
 * One UUID per attempt, kept in `sessionStorage` (this tab only) together with the cart
 * fingerprint it was made for:
 * - a retry of the SAME cart (double click, 503, network error, reload) reuses the key, so the
 *   API resumes the order instead of creating a second one;
 * - a different cart gets a new key (reusing one for another cart is 422
 *   `idempotency_key_reused`);
 * - the key is dropped on success and on any definitive 4xx.
 */

export const CHECKOUT_ATTEMPT_KEY = 'udemy.checkout-attempt.v1';

const AttemptSchema = z.object({ key: IdempotencyKeySchema, fingerprint: z.string() });

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** A fallback for runtimes without `crypto.randomUUID` (insecure contexts): RFC 4122 v4. */
function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The key for checking out the cart with this fingerprint (stored, or a new one). */
export function checkoutAttemptKey(fingerprint: string): string {
  const store = session();
  try {
    const raw = store?.getItem(CHECKOUT_ATTEMPT_KEY);
    if (raw) {
      const parsed = AttemptSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.fingerprint === fingerprint) return parsed.data.key;
    }
  } catch {
    // Unreadable: start a new attempt.
  }
  const key = uuidV4();
  try {
    store?.setItem(CHECKOUT_ATTEMPT_KEY, JSON.stringify({ key, fingerprint }));
  } catch {
    // Without storage the key still protects this click (only a reload loses it).
  }
  return key;
}

export function clearCheckoutAttempt(): void {
  try {
    session()?.removeItem(CHECKOUT_ATTEMPT_KEY);
  } catch {
    // Nothing to clear.
  }
}
