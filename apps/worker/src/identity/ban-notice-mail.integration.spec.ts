import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import { sql } from '@udemy/db';
import { eventMessageId, SmtpMailer } from '@udemy/nest-common/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import {
  deleteMail,
  itSmtpHost,
  itSmtpPort,
  useIntegrationStack,
  waitForMail,
} from '../testing/integration';
import {
  UserBannedMailerHandler,
  UserUnbannedMailerHandler,
} from './handlers/ban-notice-mailer.handlers';
import { IdentityLinks } from './mail/identity-links';
import { fakeConfig } from './testing/identity-mail.fakes';

/**
 * The ban / unban notice mailers with their real adapters (Postgres for the recipient, SMTP to
 * Mailpit, the real idempotent processor). Events are built in memory, never written to the
 * outbox; no ban row is needed because the handlers only read identity.users.
 */
describe('ban notice mailers (integration: Postgres + Mailpit)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];
  const emails: string[] = [];
  const eventIds: string[] = [];
  let mailer: SmtpMailer | undefined;
  let banned: RegisteredEventHandler;
  let unbanned: RegisteredEventHandler;
  let processor: IdempotentEventProcessor;

  beforeAll(() => {
    if (it_.unavailableReason !== undefined) return;
    mailer = new SmtpMailer({
      host: itSmtpHost(),
      port: itSmtpPort(),
      from: 'Udemy Clone <no-reply@udemy.local>',
      pool: false,
    });
    const contacts = new UserContactReader();
    const links = new IdentityLinks(fakeConfig());
    banned = {
      topic: 'identity.user',
      eventType: 'UserBanned',
      consumerName: 'it.identity.ban-notice-mailer',
      handler: new UserBannedMailerHandler(contacts, mailer, links),
    };
    unbanned = {
      topic: 'identity.user',
      eventType: 'UserUnbanned',
      consumerName: 'it.identity.unban-notice-mailer',
      handler: new UserUnbannedMailerHandler(contacts, mailer, links),
    };
    processor = new IdempotentEventProcessor(it_.db);
  });

  afterAll(async () => {
    mailer?.close();
    if (it_.unavailableReason !== undefined) return;
    if (eventIds.length > 0) {
      await it_.db.deleteFrom('outbox.processedEvents').where('eventId', 'in', eventIds).execute();
    }
    if (userIds.length > 0) {
      await it_.db.deleteFrom('identity.users').where('id', 'in', userIds).execute();
    }
    await Promise.all(emails.map((e) => deleteMail(e)));
  });

  async function newUser(): Promise<{ id: string; email: string }> {
    const email = `it-worker-ban-${randomUUID()}@example.test`;
    const row = await it_.db
      .insertInto('identity.users')
      .values({
        email,
        displayName: 'Banned IT',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$aW50ZWdyYXRpb24$aW50ZWdyYXRpb24',
        passwordChangedAt: sql<Date>`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userIds.push(row.id);
    emails.push(email);
    return { id: row.id, email };
  }

  function envelope(eventType: string, userId: string, payload: object): EventEnvelope {
    const eventId = randomUUID();
    eventIds.push(eventId);
    return {
      eventId,
      eventType,
      aggregateType: 'identity.user',
      aggregateId: userId,
      occurredAt: new Date().toISOString(),
      version: 1,
      payload,
    };
  }

  it('UserBanned then UserUnbanned -> exactly one mail each (redeliveries send nothing), in order', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await newUser();
    const banId = randomUUID();
    const reason = 'Repeated <spam> in course Q&A threads.';
    const ban = envelope('UserBanned', user.id, {
      userId: user.id,
      banId,
      reason,
      bannedBy: randomUUID(),
      bannedAt: new Date().toISOString(),
    });
    const unban = envelope('UserUnbanned', user.id, {
      userId: user.id,
      banId,
      liftedBy: randomUUID(),
      liftedAt: new Date().toISOString(),
    });

    await expect(processor.process(banned, ban)).resolves.toBe('processed');
    await expect(processor.process(banned, ban)).resolves.toBe('duplicate');
    const first = await waitForMail(user.email, { count: 1 });
    expect(first[0]?.Subject).toBe('Your account has been suspended');

    await expect(processor.process(unbanned, unban)).resolves.toBe('processed');
    await expect(processor.process(unbanned, unban)).resolves.toBe('duplicate');
    await waitForMail(user.email, { count: 2 });
    await new Promise((resolve) => setTimeout(resolve, 750));
    const mails = await waitForMail(user.email, { count: 2 });
    expect(mails).toHaveLength(2);

    const [banMail, unbanMail] = mails;
    expect(`<${banMail?.MessageID}>`).toBe(eventMessageId(ban.eventId));
    expect(banMail?.Text).toContain(`Reason: ${reason}`);
    expect(banMail?.HTML).toContain('Reason: Repeated &lt;spam&gt; in course Q&amp;A threads.');
    expect(banMail?.Text).toContain('contact support at no-reply@udemy.local.');

    expect(unbanMail?.Subject).toBe('Your account access has been restored');
    expect(`<${unbanMail?.MessageID}>`).toBe(eventMessageId(unban.eventId));
    expect(unbanMail?.Text).toContain('Sign in: http://localhost:3000/login');
    expect(unbanMail?.HTML).toContain('href="http://localhost:3000/login"');
  }, 30_000);
});
