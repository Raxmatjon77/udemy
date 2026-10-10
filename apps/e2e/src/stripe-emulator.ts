import { stripeEmulatorUrl } from './env';

/** One webhook delivery record of the emulator (`GET /_emulator/events`). */
export interface EmulatorEvent {
  id: string;
  type: string;
  status: 'pending' | 'retrying' | 'delivered' | 'failed' | 'not_configured';
  attempts: { kind: string; statusCode: number | null; error: string | null }[];
}

/**
 * Thin client of the emulator's control API (`/_emulator/*`, apps/stripe-emulator/README.md) for
 * the Phase 4 journeys. The emulator is shared by the whole run, so journeys look up their own
 * sessions and events instead of calling `/_emulator/reset`.
 */
export class StripeEmulator {
  constructor(private readonly baseUrl: string = stripeEmulatorUrl) {}

  /** Waits until no webhook is queued, in flight or waiting to retry. */
  async drainWebhooks(timeoutMs = 10_000): Promise<boolean> {
    const body = await this.request<{ idle: boolean }>(
      'POST',
      `/_emulator/webhooks/drain?timeoutMs=${timeoutMs}`,
    );
    return body.idle;
  }

  /** Sent events, oldest first, optionally filtered by type and delivery status. */
  async events(
    filter: { type?: string; status?: EmulatorEvent['status'] } = {},
  ): Promise<EmulatorEvent[]> {
    const query = new URLSearchParams(
      Object.entries(filter).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const body = await this.request<{ data?: EmulatorEvent[] } | EmulatorEvent[]>(
      'GET',
      `/_emulator/events${suffix}`,
    );
    return Array.isArray(body) ? body : (body.data ?? []);
  }

  /** Pays an open Checkout Session without the browser (same as the pay page's Pay button). */
  async completeSession(sessionId: string): Promise<{ redirectUrl: string }> {
    return this.request(
      'POST',
      `/_emulator/checkout/sessions/${encodeURIComponent(sessionId)}/complete`,
    );
  }

  /** Expires an open Checkout Session now (`checkout.session.expired`). */
  async expireSession(sessionId: string): Promise<void> {
    await this.request(
      'POST',
      `/_emulator/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    );
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`stripe-emulator ${method} ${path}: ${response.status} ${text}`);
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}
