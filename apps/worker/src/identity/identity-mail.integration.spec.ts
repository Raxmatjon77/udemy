import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import { sql } from '@udemy/db';
import { eventMessageId, SmtpMailer } from '@udemy/nest-common/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import {
  claimEvent,
  IdempotentEventProcessor,
} from '../messaging/idempotency/idempotent-event-processor';
import { testHandlerContext } from '../testing/handler-context';
import {
  deleteMail,
  itSmtpHost,
  itSmtpPort,
  tokenFromMail,
  useIntegrationStack,
  waitForMail,
} from '../testing/integration';
import { EmailVerificationMailerHandler } from './handlers/email-verification-mailer.handler';
import { PasswordResetMailerHandler } from './handlers/password-reset-mailer.handler';
import { IdentityLinks } from './mail/identity-links';
import { IssueOneTimeToken } from './one-time-tokens/issue-one-time-token';
import { KyselyOneTimeTokenStore } from './one-time-tokens/kysely-one-time-token.store';
import { hashOneTimeToken } from './one-time-tokens/one-time-token';
import { fakeConfig } from './testing/identity-mail.fakes';

/**
 * The identity mail consumers with their real adapters: Kysely against the dev Postgres, SMTP
 * to Mailpit, the real idempotent processor (processed_events claim in the same transaction).
 * Users are created with SQL (the api use cases are covered by the api's own integration
 * test); events are built in memory and never written to the outbox, so a running worker
 * cannot pick them up.
 */
describe('identity mail consumers (integration: Postgres + Mailpit)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];
  const emails: string[] = [];
  const eventIds: string[] = [];
  let mailer: SmtpMailer | undefined;
  let verification: RegisteredEventHandler;
  let reset: RegisteredEventHandler;
  let processor: IdempotentEventProcessor;

  beforeAll(() => {
    if (it_.unavailableReason !== undefined) return;
    mailer = new SmtpMailer({
      host: itSmtpHost(),
      port: itSmtpPort(),
      from: 'Udemy Clone <no-reply@udemy.local>',
      pool: false,
    });
    const config = fakeConfig();
    const issuer = new IssueOneTimeToken(new KyselyOneTimeTokenStore(), config);
    const links = new IdentityLinks(config);
    verification = {
      topic: 'identity.user',
      eventType: 'EmailVerificationRequested',
      consumerName: 'it.identity.email-verification-mailer',
      handler: new EmailVerificationMailerHandler(issuer, mailer, links),
    };
    reset = {
      topic: 'identity.user',
      eventType: 'PasswordResetRequested',
      consumerName: 'it.identity.password-reset-mailer',
      handler: new PasswordResetMailerHandler(issuer, mailer, links),
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
      await it_.db.deleteFrom('identity.oneTimeTokens').where('userId', 'in', userIds).execute();
      await it_.db.deleteFrom('identity.users').where('id', 'in', userIds).execute();
    }
    await Promise.all(emails.map((e) => deleteMail(e)));
  });

  async function newUser(): Promise<{ id: string; email: string }> {
    const email = `it-worker-${randomUUID()}@example.test`;
    const row = await it_.db
      .insertInto('identity.users')
      .values({
        email,
        displayName: 'Worker IT <User>',
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

  const tokenRow = (rawToken: string) =>
    it_.db
      .selectFrom('identity.oneTimeTokens')
      .selectAll()
      .where('tokenHash', '=', hashOneTimeToken(rawToken))
      .executeTakeFirst();

  it('signup event -> verification mail -> the link token is the live row; redeliveries re-send the SAME valid link', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await newUser();
    const requestedAt = new Date();
    const event = envelope('EmailVerificationRequested', user.id, {
      userId: user.id,
      email: user.email,
      displayName: 'Worker IT <User>',
      reason: 'SIGNUP',
      requestedAt: requestedAt.toISOString(),
    });

    // 1. "Mail sent, commit failed": the claim and the token row roll back.
    await expect(
      it_.db.transaction().execute(async (trx) => {
        await claimEvent(trx, verification.consumerName, event.eventId);
        await verification.handler.handle(event, trx, testHandlerContext());
        throw new Error('simulated commit failure');
      }),
    ).rejects.toThrow('simulated commit failure');
    expect(
      await it_.db
        .selectFrom('identity.oneTimeTokens')
        .select('id')
        .where('sourceEventId', '=', event.eventId)
        .executeTakeFirst(),
    ).toBeUndefined();

    // 2. Kafka redelivers: processed once, then a duplicate.
    await expect(processor.process(verification, event)).resolves.toBe('processed');
    await expect(processor.process(verification, event)).resolves.toBe('duplicate');

    // 3. Both mails carry the same link and Message-ID.
    const mails = await waitForMail(user.email, { count: 2 });
    expect(mails).toHaveLength(2);
    const token = tokenFromMail(mails[0]?.Text ?? '', '/verify-email');
    expect(tokenFromMail(mails[1]?.Text ?? '', '/verify-email')).toBe(token);
    expect(`<${mails[0]?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mails[0]?.Text).toContain(`http://localhost:3000/verify-email#token=${token}`);
    expect(mails[0]?.HTML).toContain('Worker IT &lt;User&gt;');

    // 4. The api's lookup (sha256 of the presented token) finds the live row.
    const row = await tokenRow(token);
    expect(row).toMatchObject({
      userId: user.id,
      purpose: 'EMAIL_VERIFICATION',
      email: user.email,
      sourceEventId: event.eventId,
      consumedAt: null,
      invalidatedAt: null,
    });
    expect(row?.expiresAt.getTime()).toBe(requestedAt.getTime() + 24 * 60 * 60 * 1000);

    // 5. A handler re-run for the same event (claim gone, row kept) does not invalidate it.
    await it_.db
      .transaction()
      .execute((trx) => verification.handler.handle(event, trx, testHandlerContext()));
    const third = await waitForMail(user.email, { count: 3 });
    expect(tokenFromMail(third[2]?.Text ?? '', '/verify-email')).toBe(token);
    expect(await tokenRow(token)).toMatchObject({ consumedAt: null, invalidatedAt: null });
  }, 30_000);

  it('forgot events -> reset mails; a newer request supersedes the older link and a late redelivery of the older one is skipped', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await newUser();
    const t0 = new Date(Date.now() - 2_000);
    const payload = (at: Date) => ({
      userId: user.id,
      email: user.email,
      displayName: 'Worker IT <User>',
      requestedAt: at.toISOString(),
    });
    const older = envelope('PasswordResetRequested', user.id, payload(t0));
    const newer = envelope(
      'PasswordResetRequested',
      user.id,
      payload(new Date(t0.getTime() + 1_000)),
    );

    await processor.process(reset, older);
    await processor.process(reset, newer);
    const mails = await waitForMail(user.email, { count: 2 });
    const oldToken = tokenFromMail(mails[0]?.Text ?? '', '/reset-password');
    const newToken = tokenFromMail(mails[1]?.Text ?? '', '/reset-password');
    expect(newToken).not.toBe(oldToken);
    expect((await tokenRow(oldToken))?.invalidatedAt).not.toBeNull();
    expect(await tokenRow(newToken)).toMatchObject({
      purpose: 'PASSWORD_RESET',
      invalidatedAt: null,
    });

    // Out-of-order redelivery of the older event: skipped, no mail, newer link untouched.
    await it_.db
      .transaction()
      .execute((trx) => reset.handler.handle(older, trx, testHandlerContext()));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(waitForMail(user.email, { count: 2 })).resolves.toHaveLength(2);
    expect((await tokenRow(newToken))?.invalidatedAt).toBeNull();
  }, 30_000);

  it('skips (no row, no mail) when the event email is no longer the account email', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await newUser();
    const event = envelope('PasswordResetRequested', user.id, {
      userId: user.id,
      email: `old-${user.email}`,
      displayName: 'Worker IT',
      requestedAt: new Date().toISOString(),
    });
    await processor.process(reset, event);
    const row = await it_.db
      .selectFrom('identity.oneTimeTokens')
      .select('id')
      .where('sourceEventId', '=', event.eventId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  }, 30_000);
});
