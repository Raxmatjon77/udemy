import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import { sql } from '@udemy/db';
import { eventMessageId, SmtpMailer } from '@udemy/nest-common/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeConfig } from '../identity/testing/identity-mail.fakes';
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
  ApplicationApprovedMailerHandler,
  ApplicationRejectedMailerHandler,
} from './handlers/application-decision-mailer.handlers';
import { UsersLinks } from './mail/users-links';

/**
 * The instructor-application decision mailers with their real adapters: Kysely against the dev
 * Postgres (current email/name from identity.users), SMTP to Mailpit, and the real idempotent
 * processor (processed_events claim in the same transaction). Events are built in memory and
 * never written to the outbox, so a running worker cannot pick them up.
 */
describe('instructor application decision mailers (integration: Postgres + Mailpit)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];
  const emails: string[] = [];
  const eventIds: string[] = [];
  let mailer: SmtpMailer | undefined;
  let approved: RegisteredEventHandler;
  let rejected: RegisteredEventHandler;
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
    const links = new UsersLinks(fakeConfig());
    approved = {
      topic: 'users.instructor_application',
      eventType: 'InstructorApplicationApproved',
      consumerName: 'it.users.application-approved-mailer',
      handler: new ApplicationApprovedMailerHandler(contacts, mailer, links),
    };
    rejected = {
      topic: 'users.instructor_application',
      eventType: 'InstructorApplicationRejected',
      consumerName: 'it.users.application-rejected-mailer',
      handler: new ApplicationRejectedMailerHandler(contacts, mailer, links),
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
    const email = `it-worker-users-${randomUUID()}@example.test`;
    const row = await it_.db
      .insertInto('identity.users')
      .values({
        email,
        displayName: 'Applicant <IT>',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$aW50ZWdyYXRpb24$aW50ZWdyYXRpb24',
        passwordChangedAt: sql<Date>`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userIds.push(row.id);
    emails.push(email);
    return { id: row.id, email };
  }

  function envelope(eventType: string, payload: object): EventEnvelope {
    const eventId = randomUUID();
    eventIds.push(eventId);
    return {
      eventId,
      eventType,
      aggregateType: 'users.instructor_application',
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      version: 1,
      payload,
    };
  }

  /** Waits for exactly `count` mails: polls for them, then makes sure no extra one arrives. */
  async function exactlyMails(address: string, count: number) {
    await waitForMail(address, { count });
    await new Promise((resolve) => setTimeout(resolve, 750));
    return waitForMail(address, { count });
  }

  it('Approved -> one mail to the CURRENT address with the instructor-app link; a redelivery sends nothing', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await newUser();
    // The applicant changed their email after applying: the mail goes to the current one.
    const current = `it-worker-users-new-${randomUUID()}@example.test`;
    await it_.db
      .updateTable('identity.users')
      .set({ email: current })
      .where('id', '=', user.id)
      .execute();
    emails.push(current);

    const event = envelope('InstructorApplicationApproved', {
      applicationId: randomUUID(),
      applicantId: user.id,
      decidedBy: randomUUID(),
      decidedAt: new Date().toISOString(),
    });

    await expect(processor.process(approved, event)).resolves.toBe('processed');
    await expect(processor.process(approved, event)).resolves.toBe('duplicate');

    const mails = await exactlyMails(current, 1);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.Subject).toBe("You're now an instructor");
    expect(`<${mails[0]?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mails[0]?.Text).toContain('Open the instructor app: http://localhost:3001/login');
    expect(mails[0]?.HTML).toContain('href="http://localhost:3001/login"');
    expect(mails[0]?.HTML).toContain('Hi Applicant &lt;IT&gt;,');
    await expect(waitForMail(user.email, { timeoutMs: 300 })).rejects.toThrow(/Timed out/);
  }, 30_000);

  it('Rejected -> one mail with the escaped reason and the become-instructor link; a redelivery sends nothing', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await newUser();
    const reason = 'Please describe your <b>teaching</b> experience & topics.';
    const event = envelope('InstructorApplicationRejected', {
      applicationId: randomUUID(),
      applicantId: user.id,
      decidedBy: randomUUID(),
      reason,
      decidedAt: new Date().toISOString(),
    });

    await expect(processor.process(rejected, event)).resolves.toBe('processed');
    await expect(processor.process(rejected, event)).resolves.toBe('duplicate');

    const mails = await exactlyMails(user.email, 1);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.Subject).toBe('Your instructor application was not approved');
    expect(`<${mails[0]?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mails[0]?.Text).toContain(`Reason: ${reason}`);
    expect(mails[0]?.Text).toContain('Apply again: http://localhost:3000/become-instructor');
    expect(mails[0]?.HTML).toContain(
      'Reason: Please describe your &lt;b&gt;teaching&lt;/b&gt; experience &amp; topics.',
    );
  }, 30_000);

  it('skips quietly (processed, no mail) when the applicant no longer exists', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await newUser();
    await it_.db.deleteFrom('identity.users').where('id', '=', user.id).execute();
    const event = envelope('InstructorApplicationApproved', {
      applicationId: randomUUID(),
      applicantId: user.id,
      decidedBy: randomUUID(),
      decidedAt: new Date().toISOString(),
    });
    await expect(processor.process(approved, event)).resolves.toBe('processed');
    await expect(waitForMail(user.email, { timeoutMs: 750 })).rejects.toThrow(/Timed out/);
  }, 30_000);
});
