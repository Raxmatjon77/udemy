import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventMessageId } from './message-id';
import { SmtpMailer } from './smtp-mailer';

/**
 * Sends through the dev Mailpit (infra/docker/docker-compose.dev.yml) and reads it back via
 * the Mailpit API. Skips when Mailpit is not running.
 */
const SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 1025);
const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025/api/v1';

interface MailpitSummary {
  ID: string;
  MessageID: string;
  Subject: string;
  To: { Address: string }[];
}

async function mailpitReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_API}/info`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function findBySubject(
  subject: string,
  timeoutMs = 5_000,
): Promise<MailpitSummary | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_API}/messages?limit=50`);
    const body = (await res.json()) as { messages: MailpitSummary[] };
    const found = body.messages.find((m) => m.Subject === subject);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

describe('SmtpMailer -> Mailpit (integration)', () => {
  let reachable = false;
  let mailer: SmtpMailer;
  const sentIds: string[] = [];

  beforeAll(async () => {
    reachable = await mailpitReachable();
    mailer = new SmtpMailer({
      host: SMTP_HOST,
      port: SMTP_PORT,
      from: 'Udemy Clone <no-reply@udemy.local>',
    });
  });

  afterAll(async () => {
    mailer.close();
    if (reachable && sentIds.length > 0) {
      await fetch(`${MAILPIT_API}/messages`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ IDs: sentIds }),
      });
    }
  });

  it('delivers the message with the requested Message-ID', async (ctx) => {
    if (!reachable) ctx.skip();

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
