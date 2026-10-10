import { idempotencyMismatch, invalidRequest } from '../http/stripe-error';

/** A stored response, replayed byte for byte with `Idempotent-Replayed: true`. */
export interface StoredResponse {
  readonly status: number;
  readonly body: string;
  readonly requestId: string;
}

interface Entry {
  readonly fingerprint: string;
  readonly response: StoredResponse;
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export type IdempotencyLookup =
  { readonly kind: 'miss' } | { readonly kind: 'replay'; readonly response: StoredResponse };

/**
 * Stripe's idempotency semantics for POST requests, per API key:
 * - same key + same method/path/parameters → the original response is replayed;
 * - same key + anything different → 400 `idempotency_error`;
 * - only requests that executed (2xx) are saved: a request rejected by validation is not, so a
 *   corrected retry with the same key runs (Stripe: "results are only saved if an API endpoint
 *   started executing").
 * Keys never expire here (Stripe keeps them ≥ 24 h); `reset()` clears them.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  static validateKey(key: string): void {
    if (key.trim() === '' || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw invalidRequest(
        `Invalid Idempotency-Key: it must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      );
    }
  }

  lookup(apiKey: string, key: string, fingerprint: string): IdempotencyLookup {
    const entry = this.entries.get(`${apiKey}\u0000${key}`);
    if (entry === undefined) return { kind: 'miss' };
    if (entry.fingerprint !== fingerprint) throw idempotencyMismatch(key);
    return { kind: 'replay', response: entry.response };
  }

  save(apiKey: string, key: string, fingerprint: string, response: StoredResponse): void {
    this.entries.set(`${apiKey}\u0000${key}`, { fingerprint, response });
  }

  get size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
  }
}
