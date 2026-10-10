import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventMessageId } from './message-id';
import { SmtpMailer } from './smtp-mailer';

/**
 * Sends through Mailpit and reads the message back via the Mailpit API. Same convention as the
 * api integration tests (apps/api/src/testing/integration.ts):
 *
 * - `IT_SMTP_HOST` / `IT_SMTP_PORT` / `IT_MAILPIT_URL` (the same variables as the worker's
 *   src/testing/integration.ts), defaulting to the dev compose stack
 *   (infra/docker/docker-compose.dev.yml: SMTP on 1025, web/API on 8025).
 * - Locally, an unreachable Mailpit SKIPS the test with a clear message.
 * - With `CI=true` (GitLab), an unreachable Mailpit FAILS: CI must not go green by skipping.
 * - A Mailpit that accepts the connection but does not answer in time always FAILS.
 * - Only this test's message is looked up (by its unique subject) and deleted afterwards.
 */
const SMTP_HOST = nonEmpty(process.env.IT_SMTP_HOST) ?? 'localhost';
const SMTP_PORT = Number(nonEmpty(process.env.IT_SMTP_PORT) ?? 1025);
const MAILPIT_API = `${(nonEmpty(process.env.IT_MAILPIT_URL) ?? 'http://localhost:8025').replace(/\/+$/, '')}/api/v1`;
/** Below vitest's 10 s default hookTimeout, so this message wins over "Hook timed out". */
const PROBE_TIMEOUT_MS = 8_000;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

interface MailpitSummary {
  ID: string;
  MessageID: string;
  Subject: string;
  To: { Address: string }[];
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === 'string' ? `${cause.code}: ` : '';
  return `${code}${error.message}`;
}

/** undefined when reachable; otherwise why (or throws: CI, or a stalled Mailpit). */
async function probeMailpit(): Promise<string | undefined> {
  try {
    const res = await fetch(`${MAILPIT_API}/info`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET /info answered ${res.status}`);
    return undefined;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `[integration] Mailpit at ${MAILPIT_API} did not answer within ${PROBE_TIMEOUT_MS} ms. ` +
          'It is running, so this is not skipped: the host or the Docker VM is overloaded.',
        { cause: error },
      );
    }
    const reason =
      `Mailpit at ${MAILPIT_API} is unreachable (${describeError(error)}). ` +
      'Start infra/docker/docker-compose.dev.yml or set IT_SMTP_HOST / IT_SMTP_PORT / ' +
      'IT_MAILPIT_URL.';
    if (process.env.CI === 'true') {
      throw new Error(
        `[integration] ${reason} CI=true: integration tests must not be skipped in CI.`,
        { cause: error },
      );
    }
    process.stderr.write(`[integration] ${reason} Skipping its integration tests.\n`);
    return reason;
  }
}

/** Searches by the (unique) subject, so unrelated mail in a shared Mailpit never interferes. */
async function findBySubject(
  subject: string,
  timeoutMs = 10_000,
): Promise<MailpitSummary | undefined> {
  const query = encodeURIComponent(`subject:"${subject}"`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_API}/search?query=${query}`);
    const body = (await res.json()) as { messages: MailpitSummary[] };
    const found = body.messages.find((m) => m.Subject === subject);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

describe('SmtpMailer -> Mailpit (integration)', () => {
  let unavailable: string | undefined = 'not probed yet';
  let mailer: SmtpMailer;
  const sentIds: string[] = [];

  beforeAll(async () => {
    unavailable = await probeMailpit();
    mailer = new SmtpMailer({
      host: SMTP_HOST,
      port: SMTP_PORT,
      from: 'Udemy Clone <no-reply@udemy.local>',
    });
  });

  afterAll(async () => {
    mailer?.close();
    if (unavailable === undefined && sentIds.length > 0) {
      await fetch(`${MAILPIT_API}/messages`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ IDs: sentIds }),
      });
    }
  });

  it('delivers the message with the requested Message-ID', { timeout: 30_000 }, async (ctx) => {
    ctx.skip(unavailable !== undefined, unavailable);

    const eventId = randomUUID();
    const subject = `nest-common integration ${eventId}`;
    const messageId = eventMessageId(eventId);

    const result = await mailer.send({
      to: 'student@example.test',
      subject,
      text: 'Plain text body',
      html: '<p>HTML body</p>',
      messageId,
    });

    expect(result.messageId).toBe(messageId);
    expect(result.accepted).toEqual(['student@example.test']);

    const stored = await findBySubject(subject);
    expect(stored).toBeDefined();
    if (!stored) return;
    sentIds.push(stored.ID);
    // Mailpit stores the msg-id without the angle brackets.
    expect(`<${stored.MessageID.replace(/^<|>$/g, '')}>`).toBe(messageId);
    expect(stored.To.map((to) => to.Address)).toEqual(['student@example.test']);
  });
});
