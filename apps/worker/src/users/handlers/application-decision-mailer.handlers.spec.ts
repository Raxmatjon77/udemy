import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { FAKE_TRX, fakeConfig, RecordingMailer } from '../../identity/testing/identity-mail.fakes';
import { NonRetryableError } from '../../messaging';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { UsersLinks } from '../mail/users-links';
import {
  ApplicationApprovedMailerHandler,
  ApplicationRejectedMailerHandler,
} from './application-decision-mailer.handlers';

const APPLICATION = '0199c8a0-0000-7000-8000-0000000000a1';
const APPLICANT = '0199c8a0-0000-7000-8000-000000000001';
const ADMIN = '0199c8a0-0000-7000-8000-000000000002';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-10-10T10:00:00.000Z');
const REASON = 'Please add <b>more</b> detail about your teaching experience.';

function envelope(eventType: string, payload: unknown, version = 1): EventEnvelope {
  return {
    eventId: EVENT,
    eventType,
    aggregateType: 'users.instructor_application',
    aggregateId: APPLICATION,
    occurredAt: NOW.toISOString(),
    version,
    payload,
  };
}

const approved = (overrides: Record<string, unknown> = {}, version = 1): EventEnvelope =>
  envelope(
    'InstructorApplicationApproved',
    {
      applicationId: APPLICATION,
      applicantId: APPLICANT,
      decidedBy: ADMIN,
      decidedAt: NOW.toISOString(),
      ...overrides,
    },
    version,
  );

const rejected = (overrides: Record<string, unknown> = {}, version = 1): EventEnvelope =>
  envelope(
    'InstructorApplicationRejected',
    {
      applicationId: APPLICATION,
      applicantId: APPLICANT,
      decidedBy: ADMIN,
      reason: REASON,
      decidedAt: NOW.toISOString(),
      ...overrides,
    },
    version,
  );

/** Returns a fixed contact and records which user ids were looked up. */
class FakeContacts extends UserContactReader {
  readonly lookups: string[] = [];
  constructor(private readonly contact: UserContact | null) {
    super();
  }
  override async find(_trx: Transaction<DB>, userId: string): Promise<UserContact | null> {
    this.lookups.push(userId);
    return this.contact;
  }
}

describe('instructor application decision mailers', () => {
  const links = new UsersLinks(fakeConfig());
  const jane: UserContact = { email: 'jane.current@example.com', displayName: 'Jane <Doe>' };
  let mailer: RecordingMailer;

  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  describe('ApplicationApprovedMailerHandler', () => {
    it("mails the applicant's CURRENT address with the instructor-app link and Message-ID", async () => {
      const contacts = new FakeContacts(jane);
      await new ApplicationApprovedMailerHandler(contacts, mailer, links).handle(
        approved(),
        FAKE_TRX,
      );

      expect(contacts.lookups).toEqual([APPLICANT]);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]).toMatchObject({
        to: 'jane.current@example.com',
        subject: "You're now an instructor",
        messageId: `<${EVENT}@udemy.local>`,
      });
      expect(mailer.sent[0]?.text).toContain('http://localhost:3001/login');
      expect(mailer.sent[0]?.html).toContain('Hi Jane &lt;Doe&gt;,');
    });

    it('skips quietly when the applicant no longer exists', async () => {
      await new ApplicationApprovedMailerHandler(new FakeContacts(null), mailer, links).handle(
        approved(),
        FAKE_TRX,
      );
      expect(mailer.sent).toHaveLength(0);
    });

    it('dead-letters an unsupported version and a payload that breaks the contract', async () => {
      const handler = new ApplicationApprovedMailerHandler(new FakeContacts(jane), mailer, links);
      await expect(handler.handle(approved({}, 2), FAKE_TRX)).rejects.toBeInstanceOf(
        NonRetryableError,
      );
      await expect(
        handler.handle(approved({ applicantId: 'not-a-uuid' }), FAKE_TRX),
      ).rejects.toBeInstanceOf(ZodError);
      expect(mailer.sent).toHaveLength(0);
    });
  });

  describe('ApplicationRejectedMailerHandler', () => {
    it('mails the escaped reason and the become-instructor link', async () => {
      await new ApplicationRejectedMailerHandler(new FakeContacts(jane), mailer, links).handle(
        rejected(),
        FAKE_TRX,
      );

      expect(mailer.sent).toHaveLength(1);
      const mail = mailer.sent[0];
      expect(mail).toMatchObject({
        to: 'jane.current@example.com',
        subject: 'Your instructor application was not approved',
        messageId: `<${EVENT}@udemy.local>`,
      });
      expect(mail?.text).toContain(`Reason: ${REASON}`);
      expect(mail?.html).toContain('Please add &lt;b&gt;more&lt;/b&gt; detail');
      expect(mail?.html).not.toContain('<b>more');
      expect(mail?.text).toContain('http://localhost:3000/become-instructor');
    });

    it('skips quietly when the applicant no longer exists', async () => {
      await new ApplicationRejectedMailerHandler(new FakeContacts(null), mailer, links).handle(
        rejected(),
        FAKE_TRX,
      );
      expect(mailer.sent).toHaveLength(0);
    });

    it('dead-letters an unsupported version and a reason outside the contract', async () => {
      const handler = new ApplicationRejectedMailerHandler(new FakeContacts(jane), mailer, links);
      await expect(handler.handle(rejected({}, 2), FAKE_TRX)).rejects.toBeInstanceOf(
        NonRetryableError,
      );
      await expect(handler.handle(rejected({ reason: 'short' }), FAKE_TRX)).rejects.toBeInstanceOf(
        ZodError,
      );
      expect(mailer.sent).toHaveLength(0);
    });
  });
});
