import { infra } from './env';

/**
 * A small client for the Mailpit REST API (http://localhost:8025/api/v1). The worker sends every
 * email of the dev stack to Mailpit over SMTP; the journeys read them back from here.
 */

/** Every address the suite creates starts with this, so cleanup can target e2e mail only. */
export const E2E_ADDRESS_PREFIX = 'e2e-';

export interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string; Name: string }[];
  Created: string;
}

export interface MailMessage extends MailSummary {
  Text: string;
  HTML: string;
}

interface SearchResponse {
  messages: MailSummary[];
}

export interface WaitForMailOptions {
  to: string;
  subject: string;
  /** Default 45 s: signup → outbox → Debezium → Kafka → worker → SMTP takes a few seconds. */
  timeoutMs?: number;
  /** Ignore messages created before this instant (e.g. an earlier mail with the same subject). */
  after?: Date;
}

const POLL_INTERVAL_MS = 500;

export class Mailpit {
  constructor(private readonly baseUrl: string = infra.mailpitUrl) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path} → ${response.status}`);
    }
    return response;
  }

  async info(): Promise<{ Version: string }> {
    return (await this.request('/info')).json() as Promise<{ Version: string }>;
  }

  async search(query: string, limit = 50): Promise<MailSummary[]> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    const body = (await (await this.request(`/search?${params}`)).json()) as SearchResponse;
    return body.messages;
  }

  async message(id: string): Promise<MailMessage> {
    return (
      await this.request(`/message/${encodeURIComponent(id)}`)
    ).json() as Promise<MailMessage>;
  }

  /** Deletes every message matching a Mailpit search query. */
  async deleteMatching(query: string): Promise<void> {
    await this.request(`/search?${new URLSearchParams({ query })}`, { method: 'DELETE' });
  }

  /** Deletes the mail of the given recipients. */
  async deleteFor(addresses: readonly string[]): Promise<void> {
    for (const address of addresses) await this.deleteMatching(`to:"${address}"`);
  }

  /** Deletes all mail to e2e-generated addresses (and nothing else). */
  async deleteE2eMail(): Promise<void> {
    await this.deleteMatching(`to:${E2E_ADDRESS_PREFIX}`);
  }

  /**
   * Polls until a mail to `to` with exactly `subject` arrives, and returns it in full.
   * Polling the API is the only way to wait for an asynchronous email.
   */
  async waitForMail({
    to,
    subject,
    timeoutMs = 45_000,
    after,
  }: WaitForMailOptions): Promise<MailMessage> {
    const deadline = Date.now() + timeoutMs;
    const query = `to:"${to}" subject:"${subject.replace(/"/g, '\\"')}"`;
    for (;;) {
      const match = (await this.search(query)).find(
        (mail) =>
          mail.Subject === subject &&
          mail.To.some((r) => r.Address.toLowerCase() === to.toLowerCase()) &&
          (!after || Date.parse(mail.Created) >= after.getTime()),
      );
      if (match) return this.message(match.ID);
      if (Date.now() > deadline) {
        const seen = (await this.search(`to:"${to}"`)).map((m) => `"${m.Subject}"`);
        throw new Error(
          `No mail "${subject}" to ${to} within ${timeoutMs} ms. Mail to that address: ${
            seen.length > 0 ? seen.join(', ') : 'none'
          }. Is the worker running and consuming (see .output/logs/worker.log)?`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

/**
 * The one-time-token link of a verification / reset mail: `${origin}${path}#token=…`.
 * Read from the plain-text part, where the worker prints the action URL verbatim.
 */
export function extractTokenLink(
  mail: MailMessage,
  path: '/verify-email' | '/reset-password',
): URL {
  const pattern = new RegExp(`https?://[^\\s"'<>]+${path}#token=[^\\s"'<>]+`);
  const found = mail.Text.match(pattern) ?? mail.HTML.match(pattern);
  if (!found) {
    throw new Error(`No ${path}#token= link in mail "${mail.Subject}":\n${mail.Text}`);
  }
  // The HTML part escapes `&`; the text part does not. Either way only one param is expected.
  return new URL(found[0].replace(/&amp;/g, '&'));
}
