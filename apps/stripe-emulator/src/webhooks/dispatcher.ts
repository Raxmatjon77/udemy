import { computeWebhookSignature, SIGNATURE_SCHEME, STRIPE_API_VERSION } from '@udemy/payments';
import type { Logger } from '../logger';
import { errorMessage } from '../logger';
import type { Clock } from '../stripe/ids';
import { stripeId, unixSeconds } from '../stripe/ids';

/** The Stripe event envelope (same shape as `stripeEvent()` in `@udemy/payments/testing`). */
export interface StripeEvent {
  readonly id: string;
  readonly object: 'event';
  readonly api_version: string;
  readonly created: number;
  readonly livemode: false;
  readonly pending_webhooks: number;
  readonly request: { readonly id: string | null; readonly idempotency_key: string | null };
  readonly type: string;
  readonly data: { readonly object: Readonly<Record<string, unknown>> };
}

/** What triggered an event: the API request (`request.id`), or null for page/control/sweep. */
export interface EventRequestContext {
  readonly requestId: string | null;
  readonly idempotencyKey: string | null;
}

export const NO_REQUEST: EventRequestContext = { requestId: null, idempotencyKey: null };

/**
 * Deliberately broken deliveries for webhook-security tests (redeliver only, single attempt):
 * - `payload`: the body is altered AFTER signing (signature no longer matches the bytes);
 * - `signature`: signed with a different, random secret;
 * - `stale_timestamp`: a correct HMAC with `t` 10 minutes in the past (outside the 300 s tolerance).
 */
export type TamperMode = 'payload' | 'signature' | 'stale_timestamp';
export const TAMPER_MODES: readonly TamperMode[] = ['payload', 'signature', 'stale_timestamp'];

export type DeliveryKind = 'initial' | 'retry' | 'redelivery';

export interface DeliveryAttempt {
  readonly attempt: number;
  readonly kind: DeliveryKind;
  readonly tamper: TamperMode | null;
  readonly startedAt: string;
  /** The endpoint's HTTP status, or null when the request failed (refused, timeout). */
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly ok: boolean;
}

/**
 * `pending`: queued or in flight; `retrying`: the last attempt failed and a retry is scheduled;
 * `delivered`: an attempt got a 2xx; `failed`: retries exhausted; `not_configured`: no
 * EMULATOR_WEBHOOK_URL (stored, never sent; redeliver still works once a URL exists).
 */
export type DeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'failed' | 'not_configured';

export interface StoredEvent {
  readonly event: StripeEvent;
  /** The exact bytes every attempt sends (Stripe resends the same payload with a fresh `t`). */
  readonly body: Buffer;
  status: DeliveryStatus;
  readonly attempts: DeliveryAttempt[];
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

export interface EventSummary {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly objectId: string | null;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly attempts: readonly DeliveryAttempt[];
}

export interface WebhookDispatcherOptions {
  readonly url: string | null;
  readonly secret: string;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly logger: Logger;
}

const STALE_SECONDS = 600;
const USER_AGENT = 'Stripe/1.0 (+https://stripe.com/docs/webhooks) udemy-stripe-emulator';

/** Exponential backoff: base, 2×base, 4×base … capped. `attempt` is the attempt that failed. */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

/** `t={t},v1={hex}` over the exact bytes, with the shared `@udemy/payments` HMAC helper. */
export function signatureHeader(body: Buffer, secret: string, timestamp: number): string {
  return `t=${timestamp},${SIGNATURE_SCHEME}=${computeWebhookSignature(body, secret, timestamp)}`;
}

interface Job {
  readonly stored: StoredEvent;
  readonly attempt: number;
  readonly kind: DeliveryKind;
  readonly tamper: TamperMode | null;
  readonly done?: (attempt: DeliveryAttempt) => void;
}

/**
 * Stores every event and delivers it, signed, to `url`. Attempts run ONE AT A TIME in FIFO order
 * (deterministic arrival order for tests; Stripe itself guarantees no order), failed attempts are
 * re-queued after an exponential backoff until `maxAttempts`. A 2xx is success; anything else
 * (3xx included: Stripe does not follow redirects) is a failure.
 */
export class WebhookDispatcher {
  private readonly events = new Map<string, StoredEvent>();
  private readonly queue: Job[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private running = false;
  private closed = false;
  /** Queued + in flight + waiting on a retry timer; `whenIdle` resolves at 0. */
  private outstanding = 0;
  private scheduled = 0;
  private idleWaiters: (() => void)[] = [];
  private url: string | null;

  constructor(private readonly options: WebhookDispatcherOptions) {
    this.url = options.url;
  }

  get webhookUrl(): string | null {
    return this.url;
  }

  /** Points deliveries elsewhere at runtime (control API); null stops delivering. */
  setWebhookUrl(url: string | null): void {
    this.url = url;
  }

  /** Records a new event (unique `evt_` id) and queues its first delivery attempt. */
  emit(
    type: string,
    object: Readonly<Record<string, unknown>>,
    request: EventRequestContext,
  ): StoredEvent {
    const event: StripeEvent = {
      id: stripeId('evt', 24),
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: unixSeconds(this.options.clock()),
      livemode: false,
      pending_webhooks: this.url === null ? 0 : 1,
      request: { id: request.requestId, idempotency_key: request.idempotencyKey },
      type,
      // A deep snapshot: later state changes never alter an already-emitted event.
      data: { object: structuredClone(object) },
    };
    const stored: StoredEvent = {
      event,
      body: Buffer.from(JSON.stringify(event, null, 2), 'utf8'),
      status: this.url === null ? 'not_configured' : 'pending',
      attempts: [],
      nextAttemptAt: null,
      deliveredAt: null,
    };
    this.events.set(event.id, stored);
    this.options.logger.log('info', 'event created', { eventId: event.id, type });
    if (this.url !== null) this.enqueue({ stored, attempt: 1, kind: 'initial', tamper: null });
    return stored;
  }

  get(id: string): StoredEvent | undefined {
    return this.events.get(id);
  }

  list(filter: { type?: string; status?: DeliveryStatus } = {}): EventSummary[] {
    const result: EventSummary[] = [];
    for (const stored of this.events.values()) {
      if (filter.type !== undefined && stored.event.type !== filter.type) continue;
      if (filter.status !== undefined && stored.status !== filter.status) continue;
      result.push(summarize(stored));
    }
    return result;
  }

  /**
   * Sends a stored event again (same id, same bytes, fresh signature): one attempt, no retries,
   * whatever its current status. Resolves with the attempt once it has run.
   */
  redeliver(id: string, tamper: TamperMode | null = null): Promise<DeliveryAttempt> | undefined {
    const stored = this.events.get(id);
    if (stored === undefined) return undefined;
    return new Promise((resolve) => {
      this.enqueue({
        stored,
        attempt: stored.attempts.length + 1,
        kind: 'redelivery',
        tamper,
        done: resolve,
      });
    });
  }

  /** Resolves once nothing is queued, in flight or waiting for a retry timer. */
  whenIdle(): Promise<void> {
    if (this.outstanding === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Drops every event and pending retry (control API reset). */
  reset(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.outstanding -= this.queue.length + this.scheduled;
    this.scheduled = 0;
    for (const job of this.queue.splice(0)) {
      job.done?.({
        attempt: job.attempt,
        kind: job.kind,
        tamper: job.tamper,
        startedAt: new Date(this.options.clock()).toISOString(),
        statusCode: null,
        error: 'canceled by reset',
        ok: false,
      });
    }
    this.events.clear();
    this.url = this.options.url;
    this.settleIdle();
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  private enqueue(job: Job): void {
    if (this.closed) return;
    this.outstanding += 1;
    this.queue.push(job);
    this.pump();
  }

  private scheduleRetry(job: Job, delayMs: number): void {
    this.outstanding += 1;
    this.scheduled += 1;
    job.stored.nextAttemptAt = new Date(this.options.clock() + delayMs).toISOString();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.scheduled -= 1;
      this.outstanding -= 1;
      job.stored.nextAttemptAt = null;
      this.enqueue(job);
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private pump(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    this.running = true;
    void this.run(job).finally(() => {
      this.running = false;
      this.outstanding -= 1;
      this.pump();
      this.settleIdle();
    });
  }

  private settleIdle(): void {
    if (this.outstanding > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private async run(job: Job): Promise<void> {
    const { stored } = job;
    if (job.kind === 'retry' && stored.status === 'delivered') return; // a redelivery got through
    const url = this.url;
    if (url === null) {
      const attempt = this.record(job, null, 'EMULATOR_WEBHOOK_URL is not configured');
      job.done?.(attempt);
      return;
    }
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const request = this.signedRequest(stored.body, job.tamper);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'stripe-signature': request.signature,
          'user-agent': USER_AGENT,
        },
        body: new Uint8Array(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      statusCode = response.status;
      await response.body?.cancel();
    } catch (cause) {
      error = errorMessage(cause);
    }
    const attempt = this.record(job, statusCode, error);
    job.done?.(attempt);
  }

  private record(job: Job, statusCode: number | null, error: string | null): DeliveryAttempt {
    const { stored } = job;
    const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
    const attempt: DeliveryAttempt = {
      attempt: job.attempt,
      kind: job.kind,
      tamper: job.tamper,
      startedAt: new Date(this.options.clock()).toISOString(),
      statusCode,
      error: error ?? (ok ? null : `HTTP ${statusCode ?? 'n/a'}`),
      ok,
    };
    stored.attempts.push(attempt);
    this.options.logger.log(ok ? 'info' : 'warn', 'webhook attempt', {
      eventId: stored.event.id,
      type: stored.event.type,
      attempt: job.attempt,
      kind: job.kind,
      tamper: job.tamper,
      statusCode,
      error: attempt.error,
    });
    if (ok && job.tamper === null) {
      stored.status = 'delivered';
      stored.deliveredAt ??= attempt.startedAt;
    } else if (job.kind !== 'redelivery') {
      if (job.attempt < this.options.maxAttempts) {
        stored.status = 'retrying';
        this.scheduleRetry(
          { stored, attempt: job.attempt + 1, kind: 'retry', tamper: null },
          retryDelayMs(job.attempt, this.options.retryBaseMs, this.options.retryMaxMs),
        );
      } else {
        stored.status = 'failed';
      }
    }
    // A failed (or tampered) redelivery never changes the event's delivery status.
    return attempt;
  }

  private signedRequest(
    body: Buffer,
    tamper: TamperMode | null,
  ): { body: Buffer; signature: string } {
    const now = unixSeconds(this.options.clock());
    switch (tamper) {
      case null:
        return { body, signature: signatureHeader(body, this.options.secret, now) };
      case 'payload': {
        const signature = signatureHeader(body, this.options.secret, now);
        // Same length, one byte different: the HMAC over the received bytes cannot match.
        const altered = Buffer.from(body);
        // Still valid JSON (`false` -> `true `), so only the signature check can reject it.
        const index = altered.indexOf('"livemode": false');
        if (index >= 0) altered.write('"livemode": true ', index, 'utf8');
        else altered[altered.length - 1] = 0x20;
        return { body: altered, signature };
      }
      case 'signature':
        return { body, signature: signatureHeader(body, `whsec_${stripeId('wrong', 32)}`, now) };
      case 'stale_timestamp':
        return { body, signature: signatureHeader(body, this.options.secret, now - STALE_SECONDS) };
    }
  }
}

function summarize(stored: StoredEvent): EventSummary {
  const objectId = stored.event.data.object.id;
  return {
    id: stored.event.id,
    type: stored.event.type,
    created: stored.event.created,
    objectId: typeof objectId === 'string' ? objectId : null,
    status: stored.status,
    attemptCount: stored.attempts.length,
    nextAttemptAt: stored.nextAttemptAt,
    deliveredAt: stored.deliveredAt,
    attempts: [...stored.attempts],
  };
}
