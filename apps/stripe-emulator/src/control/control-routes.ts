import type { IncomingMessage, ServerResponse } from 'node:http';
import { mediaType, readBody, sendJson } from '../http/io';
import type { RefundOutcome, StripeEmulator } from '../stripe/emulator';
import {
  DEFAULT_REFUND_FAILURE_REASON,
  EmulatorConflictError,
  REFUND_FAILURE_REASONS,
} from '../stripe/emulator';
import type { DeliveryStatus, TamperMode, WebhookDispatcher } from '../webhooks/dispatcher';
import { TAMPER_MODES } from '../webhooks/dispatcher';

/**
 * `/_emulator/*`: test-only controls (enabled unless EMULATOR_CONTROL_ENABLED=false). JSON in,
 * JSON out; errors are `{ "error": { "message" } }` with 400/404/409. No auth: the port is
 * published on loopback only. See README.md for every endpoint.
 */

export class ControlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

export interface ControlContext {
  readonly stripe: StripeEmulator;
  readonly webhooks: WebhookDispatcher;
  /** Clears sessions, refunds, plans, idempotency keys and events. */
  readonly reset: () => void;
  readonly info: () => Record<string, unknown>;
}

type JsonBody = Readonly<Record<string, unknown>>;

type Handler = (match: RegExpExecArray, body: JsonBody, url: URL) => Promise<unknown> | unknown;

interface Route {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly summary: string;
  readonly handler: Handler;
}

const ID = '([A-Za-z0-9_]{1,255})';
const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'pending',
  'retrying',
  'delivered',
  'failed',
  'not_configured',
];
const REFUND_OUTCOMES: readonly RefundOutcome[] = ['succeeded', 'failed', 'pending'];
const MAX_DRAIN_MS = 60_000;

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const body = await readBody(req, 64 * 1024);
  if (body.length === 0) return {};
  if (mediaType(req) !== 'application/json') {
    throw new ControlError(400, 'control API bodies must be application/json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ControlError(400, 'invalid JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ControlError(400, 'the JSON body must be an object');
  }
  return parsed as JsonBody;
}

function optionalString(body: JsonBody, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new ControlError(400, `${name} must be a non-empty string`);
  }
  return value;
}

function oneOf<T extends string>(
  body: JsonBody,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = optionalString(body, name);
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw new ControlError(400, `${name} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function count(body: JsonBody): number {
  const value = body.count ?? 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new ControlError(400, 'count must be an integer in 1..100');
  }
  return value;
}

function failureReason(body: JsonBody): string {
  return (
    oneOf(body, 'failureReason', REFUND_FAILURE_REASONS as readonly string[]) ??
    DEFAULT_REFUND_FAILURE_REASON
  );
}

function routes(ctx: ControlContext): readonly Route[] {
  const { stripe, webhooks } = ctx;
  const list: Route[] = [
    {
      method: 'GET',
      pattern: /^\/_emulator\/?$/,
      summary: 'This index.',
      handler: () => ({
        ...ctx.info(),
        endpoints: list.map((route) => ({
          method: route.method,
          path: route.pattern.source
            .replace(/^\^|\$$/g, '')
            .replace(/\\\//g, '/')
            .replace(ID, ':id')
            .replace('/?', ''),
          summary: route.summary,
        })),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/_emulator\/state$/,
      summary: 'Sessions (with line items), payment intents, refunds and queued refund plans.',
      handler: () => ({ ...ctx.info(), ...stripe.snapshot() }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/_emulator/checkout/sessions/${ID}/complete$`),
      summary:
        'Pay an open session without the browser: complete + paid, checkout.session.completed. ' +
        'Returns { session, redirectUrl }.',
      handler: (match) => {
        const session = stripe.completeSession(match[1] ?? '');
        return {
          session: stripe.sessionJson(session),
          redirectUrl: stripe.successRedirect(session),
        };
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/_emulator/checkout/sessions/${ID}/expire$`),
      summary: 'Expire an open session now: checkout.session.expired.',
      handler: (match) => ({
        session: stripe.sessionJson(stripe.expireSessionNow(match[1] ?? '')),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/_emulator\/refunds\/fail-next$/,
      summary:
        'The next `count` (default 1) refunds are created pending and then fail: refund.failed. ' +
        'Body: { count?, failureReason? }.',
      handler: (_match, body) => ({
        queued: stripe.planRefunds(
          { outcome: 'failed', failureReason: failureReason(body) },
          count(body),
        ),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/_emulator\/refunds\/next$/,
      summary:
        'Plan the next refund(s): { outcome: succeeded | failed | pending, count?, failureReason? }.',
      handler: (_match, body) => {
        const outcome = oneOf(body, 'outcome', REFUND_OUTCOMES);
        if (outcome === undefined) throw new ControlError(400, 'outcome is required');
        return {
          queued: stripe.planRefunds({ outcome, failureReason: failureReason(body) }, count(body)),
        };
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/_emulator/refunds/${ID}/settle$`),
      summary:
        'Settle a pending refund: { outcome: succeeded | failed, failureReason? } ' +
        '(charge.refunded + refund.updated, or refund.failed).',
      handler: (match, body) => {
        const outcome = oneOf(body, 'outcome', ['succeeded', 'failed'] as const);
        if (outcome === undefined) throw new ControlError(400, 'outcome is required');
        const refund = stripe.settleRefund(match[1] ?? '', outcome, failureReason(body));
        return { refund: stripe.refundJson(refund) };
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/_emulator/payment_intents/${ID}/dispute$`),
      summary:
        'Open a dispute on a paid payment intent: charge.dispute.created. Body: { reason? }.',
      handler: (match, body) => ({
        dispute: stripe.createDispute(
          match[1] ?? '',
          optionalString(body, 'reason') ?? 'fraudulent',
        ),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/_emulator\/events$/,
      summary:
        'Sent events with their delivery status and attempts, oldest first. ' +
        'Query: ?type=checkout.session.completed&status=delivered.',
      handler: (_match, _body, url) => {
        const type = url.searchParams.get('type') ?? undefined;
        const rawStatus = url.searchParams.get('status') ?? undefined;
        if (
          rawStatus !== undefined &&
          !(DELIVERY_STATUSES as readonly string[]).includes(rawStatus)
        ) {
          throw new ControlError(400, `status must be one of ${DELIVERY_STATUSES.join(', ')}`);
        }
        const status = rawStatus as DeliveryStatus | undefined;
        return {
          webhookUrl: webhooks.webhookUrl,
          data: webhooks.list({
            ...(type === undefined ? {} : { type }),
            ...(status === undefined ? {} : { status }),
          }),
        };
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/_emulator/events/${ID}$`),
      summary: 'One event: delivery status, attempts and the exact JSON payload.',
      handler: (match) => {
        const stored = webhooks.get(match[1] ?? '');
        if (stored === undefined) throw new ControlError(404, `No such event: ${match[1] ?? ''}`);
        const summary = webhooks.list().find((item) => item.id === stored.event.id);
        return { ...summary, event: stored.event };
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/_emulator/events/${ID}/redeliver$`),
      summary:
        'Send an event again (same id and bytes, fresh signature; one attempt, no retries) and ' +
        'wait for the result. Body: { tamper?: payload | signature | stale_timestamp }.',
      handler: async (match, body) => {
        const tamper: TamperMode | null = oneOf(body, 'tamper', TAMPER_MODES) ?? null;
        const pending = webhooks.redeliver(match[1] ?? '', tamper);
        if (pending === undefined) throw new ControlError(404, `No such event: ${match[1] ?? ''}`);
        return { attempt: await pending };
      },
    },
    {
      method: 'POST',
      pattern: /^\/_emulator\/webhooks\/drain$/,
      summary:
        'Wait until no delivery is queued, in flight or waiting for a retry. ' +
        'Query: ?timeoutMs= (default 10000, max 60000). Returns { idle }.',
      handler: async (_match, _body, url) => {
        const raw = url.searchParams.get('timeoutMs') ?? '10000';
        const timeoutMs = Number(raw);
        if (!/^\d+$/.test(raw) || timeoutMs > MAX_DRAIN_MS) {
          throw new ControlError(400, `timeoutMs must be an integer in 0..${MAX_DRAIN_MS}`);
        }
        let timer: NodeJS.Timeout | undefined;
        const idle = await Promise.race([
          webhooks.whenIdle().then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        clearTimeout(timer);
        return { idle };
      },
    },
    {
      method: 'POST',
      pattern: /^\/_emulator\/reset$/,
      summary: 'Forget everything: sessions, payments, refunds, plans, idempotency keys, events.',
      handler: () => {
        ctx.reset();
        return { reset: true };
      },
    },
  ];
  return list;
}

/** Handles `/_emulator/*`; returns false when nothing matched (the caller answers 404). */
export function controlApi(
  ctx: ControlContext,
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const table = routes(ctx);
  return async (req, res, url) => {
    let route: Route | undefined;
    let match: RegExpExecArray | null = null;
    for (const candidate of table) {
      if (candidate.method !== req.method) continue;
      match = candidate.pattern.exec(url.pathname);
      if (match !== null) {
        route = candidate;
        break;
      }
    }
    if (route === undefined || match === null) return false;
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      sendJson(res, 200, await route.handler(match, body, url));
    } catch (error) {
      if (error instanceof ControlError || error instanceof EmulatorConflictError) {
        sendJson(res, error.status, { error: { message: error.message } });
        return true;
      }
      throw error;
    }
    return true;
  };
}
