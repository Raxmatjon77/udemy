import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { NonRetryableError } from '../../messaging';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { IdentityLinks } from '../mail/identity-links';
import { FAKE_TRX, fakeConfig, RecordingMailer } from '../testing/identity-mail.fakes';
import { UserBannedMailerHandler, UserUnbannedMailerHandler } from './ban-notice-mailer.handlers';

const USER = '0199c8a0-0000-7000-8000-000000000001';
const ADMIN = '0199c8a0-0000-7000-8000-000000000002';
const BAN = '0199c8a0-0000-7000-8000-0000000000b1';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-10-10T10:00:00.000Z');
const REASON = 'Spam in <script>Q&A</script> threads, repeatedly.';

function envelope(eventType: string, payload: unknown, version = 1): EventEnvelope {
  return {
    eventId: EVENT,
    eventType,
    aggregateType: 'identity.user',
    aggregateId: USER,
    occurredAt: NOW.toISOString(),
    version,
    payload,
  };
}

const banned = (overrides: Record<string, unknown> = {}, version = 1): EventEnvelope =>
  envelope(
    'UserBanned',
    {
      userId: USER,
      banId: BAN,
      reason: REASON,
      bannedBy: ADMIN,
      bannedAt: NOW.toISOString(),
      ...overrides,
    },
    version,
  );

const unbanned = (version = 1): EventEnvelope =>
  envelope(
    'UserUnbanned',
    { userId: USER, banId: BAN, liftedBy: ADMIN, liftedAt: NOW.toISOString() },
    version,
  );

class FakeContacts extends UserContactReader {
  constructor(private readonly contact: UserContact | null) {
    super();
  }
  override async find(_trx: Transaction<DB>, _userId: string): Promise<UserContact | null> {
    return this.contact;
  }
}

describe('ban notice mailers', () => {
  const links = new IdentityLinks(fakeConfig());
  const jane: UserContact = { email: 'jane.current@example.com', displayName: 'Jane' };
  let mailer: RecordingMailer;

  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('UserBanned: mails the current address with the escaped reason and the MAIL_FROM support address', async () => {
    await new UserBannedMailerHandler(new FakeContacts(jane), mailer, links).handle(
      banned(),
      FAKE_TRX,
    );
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail).toMatchObject({
      to: 'jane.current@example.com',
      subject: 'Your account has been suspended',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mail?.text).toContain(`Reason: ${REASON}`);
    expect(mail?.html).toContain('Spam in &lt;script&gt;Q&amp;A&lt;/script&gt; threads');
    expect(mail?.html).not.toContain('<script>');
    expect(mail?.text).toContain('contact support at no-reply@udemy.local.');
    expect(mail?.text).toContain('2026-10-10 10:00 UTC');
  });

  it('UserUnbanned: "access restored" with a sign-in link', async () => {
    await new UserUnbannedMailerHandler(new FakeContacts(jane), mailer, links).handle(
      unbanned(),
      FAKE_TRX,
    );
    expect(mailer.sent[0]).toMatchObject({
      to: 'jane.current@example.com',
      subject: 'Your account access has been restored',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mailer.sent[0]?.text).toContain('Sign in: http://localhost:3000/login');
  });

  it('skips quietly when the user no longer exists', async () => {
    const contacts = new FakeContacts(null);
    await new UserBannedMailerHandler(contacts, mailer, links).handle(banned(), FAKE_TRX);
    await new UserUnbannedMailerHandler(contacts, mailer, links).handle(unbanned(), FAKE_TRX);
    expect(mailer.sent).toHaveLength(0);
  });

  it('dead-letters an unsupported version and a payload that breaks the contract', async () => {
    const contacts = new FakeContacts(jane);
    await expect(
      new UserBannedMailerHandler(contacts, mailer, links).handle(banned({}, 2), FAKE_TRX),
    ).rejects.toBeInstanceOf(NonRetryableError);
    await expect(
      new UserUnbannedMailerHandler(contacts, mailer, links).handle(unbanned(3), FAKE_TRX),
    ).rejects.toBeInstanceOf(NonRetryableError);
    await expect(
      new UserBannedMailerHandler(contacts, mailer, links).handle(
        banned({ reason: 'x' }),
        FAKE_TRX,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mailer.sent).toHaveLength(0);
  });
});
