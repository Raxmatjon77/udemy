import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { DependencyUnavailableError } from '@udemy/nest-common';
import type { MailMessage, MailSendResult } from '@udemy/nest-common/mail';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { FAKE_TRX, fakeConfig, RecordingMailer } from '../../identity/testing/identity-mail.fakes';
import { NonRetryableError } from '../../messaging';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { CatalogLinks } from '../mail/catalog-links';
import { type AdminRecipient, AdminRecipientsReader } from '../persistence/admin-recipients.reader';
import { CourseTitleReader } from '../persistence/course-title.reader';
import {
  CoursePublishedMailerHandler,
  CourseRejectedMailerHandler,
} from './course-decision-mailer.handlers';
import { ReviewRequestedMailerHandler } from './review-requested-mailer.handler';
import { TakedownMailerHandler } from './takedown-mailer.handler';

const COURSE = '0199c8a0-0000-7000-8000-0000000000c1';
const REVISION = '0199c8a0-0000-7000-8000-0000000000d1';
const OWNER = '0199c8a0-0000-7000-8000-000000000001';
const ADMIN_A = '0199c8a0-0000-7000-8000-00000000000a';
const ADMIN_B = '0199c8a0-0000-7000-8000-00000000000b';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = '2026-10-10T10:00:00.000Z';
const REASON = 'Lecture 3 has <b>no audio</b> & the outline is incomplete.';

function envelope(eventType: string, payload: unknown, version = 1): EventEnvelope {
  return {
    eventId: EVENT,
    eventType,
    aggregateType: 'catalog.course',
    aggregateId: COURSE,
    occurredAt: NOW,
    version,
    payload,
  };
}

const submitted = (overrides: Record<string, unknown> = {}, version = 1): EventEnvelope =>
  envelope(
    'CourseSubmittedForReview',
    {
      courseId: COURSE,
      revisionId: REVISION,
      revisionNo: 2,
      ownerId: OWNER,
      kind: 'UPDATE',
      title: 'Rust <for> Everyone',
      submittedAt: NOW,
      ...overrides,
    },
    version,
  );
const published = (overrides: Record<string, unknown> = {}): EventEnvelope =>
  envelope('CoursePublished', {
    courseId: COURSE,
    revisionId: REVISION,
    revisionNo: 1,
    ownerId: OWNER,
    slug: 'rust-for-everyone',
    kind: 'INITIAL',
    decidedBy: ADMIN_A,
    publishedAt: NOW,
    ...overrides,
  });
const rejected = (overrides: Record<string, unknown> = {}): EventEnvelope =>
  envelope('CourseRejected', {
    courseId: COURSE,
    revisionId: REVISION,
    ownerId: OWNER,
    kind: 'UPDATE',
    decidedBy: ADMIN_A,
    reason: REASON,
    rejectedAt: NOW,
    ...overrides,
  });
const archived = (overrides: Record<string, unknown> = {}): EventEnvelope =>
  envelope('CourseArchived', {
    courseId: COURSE,
    ownerId: OWNER,
    actorId: ADMIN_A,
    byAdmin: true,
    reason: REASON,
    archivedAt: NOW,
    ...overrides,
  });

class FakeContacts extends UserContactReader {
  constructor(private readonly contact: UserContact | null) {
    super();
  }
  override async find(): Promise<UserContact | null> {
    return this.contact;
  }
}

class FakeAdmins extends AdminRecipientsReader {
  constructor(private readonly admins: AdminRecipient[]) {
    super();
  }
  override async list(): Promise<AdminRecipient[]> {
    return this.admins;
  }
}

/** Records which title lookup the handler used. */
class FakeTitles extends CourseTitleReader {
  readonly lookups: string[] = [];
  constructor(private readonly title: string | null) {
    super();
  }
  override async ofRevision(
    _trx: Transaction<DB>,
    courseId: string,
    revisionId: string,
  ): Promise<string | null> {
    this.lookups.push(`revision:${courseId}:${revisionId}`);
    return this.title;
  }
  override async live(_trx: Transaction<DB>, courseId: string): Promise<string | null> {
    this.lookups.push(`live:${courseId}`);
    return this.title;
  }
}

/** Fails the n-th send (0-based) with an SMTP outage. */
class FlakyMailer extends RecordingMailer {
  private count = 0;
  constructor(private readonly failAt: number) {
    super();
  }
  override async send(message: MailMessage): Promise<MailSendResult> {
    if (this.count++ === this.failAt) throw new DependencyUnavailableError('smtp');
    return super.send(message);
  }
}

const links = new CatalogLinks(fakeConfig({ ADMIN_APP_ORIGIN: 'http://localhost:3002' }));
const jane: UserContact = { email: 'jane@example.com', displayName: 'Jane <Doe>' };
const admins: AdminRecipient[] = [
  { userId: ADMIN_A, email: 'a@example.com', displayName: 'Admin A' },
  { userId: ADMIN_B, email: 'b@example.com', displayName: 'Admin B' },
];

describe('ReviewRequestedMailerHandler', () => {
  let mailer: RecordingMailer;
  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('sends one mail per admin with the review link and a per-recipient Message-ID', async () => {
    await new ReviewRequestedMailerHandler(
      new FakeAdmins(admins),
      new FakeContacts(jane),
      mailer,
      links,
    ).handle(submitted(), FAKE_TRX);
    expect(mailer.sent.map((m) => [m.to, m.messageId])).toEqual([
      ['a@example.com', `<${EVENT}.${ADMIN_A}@udemy.local>`],
      ['b@example.com', `<${EVENT}.${ADMIN_B}@udemy.local>`],
    ]);
    const mail = mailer.sent[0];
    expect(mail?.subject).toBe('Review requested: "Rust <for> Everyone"');
    expect(mail?.text).toContain(
      `Open the review: http://localhost:3002/course-reviews/${REVISION}`,
    );
    expect(mail?.text).toContain(
      'Jane <Doe> submitted an update to the published course "Rust <for> Everyone" for review (revision 2, 2026-10-10 10:00 UTC).',
    );
    expect(mail?.html).toContain('Jane &lt;Doe&gt; submitted');
    expect(mail?.html).not.toContain('<for>');
  });

  it('sends nothing when there is no admin, and says "An instructor" for an unknown owner', async () => {
    await new ReviewRequestedMailerHandler(
      new FakeAdmins([]),
      new FakeContacts(jane),
      mailer,
      links,
    ).handle(submitted(), FAKE_TRX);
    expect(mailer.sent).toHaveLength(0);
    await new ReviewRequestedMailerHandler(
      new FakeAdmins(admins.slice(0, 1)),
      new FakeContacts(null),
      mailer,
      links,
    ).handle(submitted({ kind: 'INITIAL' }), FAKE_TRX);
    expect(mailer.sent[0]?.text).toContain(
      'An instructor submitted a new course "Rust <for> Everyone"',
    );
  });

  it('propagates an SMTP outage so the whole event is retried', async () => {
    const flaky = new FlakyMailer(1);
    await expect(
      new ReviewRequestedMailerHandler(
        new FakeAdmins(admins),
        new FakeContacts(jane),
        flaky,
        links,
      ).handle(submitted(), FAKE_TRX),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(flaky.sent).toHaveLength(1);
  });

  it('dead-letters an unsupported version', async () => {
    await expect(
      new ReviewRequestedMailerHandler(
        new FakeAdmins(admins),
        new FakeContacts(jane),
        mailer,
        links,
      ).handle(submitted({}, 2), FAKE_TRX),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe('course decision mailers', () => {
  let mailer: RecordingMailer;
  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('Published: the reviewed revision title, builder and public links, Message-ID from the event', async () => {
    const titles = new FakeTitles('Rust & You');
    await new CoursePublishedMailerHandler(new FakeContacts(jane), titles, mailer, links).handle(
      published(),
      FAKE_TRX,
    );
    expect(titles.lookups).toEqual([`revision:${COURSE}:${REVISION}`]);
    const mail = mailer.sent[0];
    expect(mail).toMatchObject({
      to: 'jane@example.com',
      subject: 'Your course is live',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mail?.text).toContain('"Rust & You" was approved and is now published');
    expect(mail?.text).toContain(
      'Public course page: http://localhost:3000/course/rust-for-everyone',
    );
    expect(mail?.text).toContain(`Open your course: http://localhost:3001/courses/${COURSE}`);
    expect(mail?.html).toContain('&quot;Rust &amp; You&quot;');
  });

  it('Published UPDATE wording; unknown course falls back to "your course"', async () => {
    await new CoursePublishedMailerHandler(
      new FakeContacts(jane),
      new FakeTitles(null),
      mailer,
      links,
    ).handle(published({ kind: 'UPDATE' }), FAKE_TRX);
    expect(mailer.sent[0]?.subject).toBe('Your course update is live');
    expect(mailer.sent[0]?.text).toContain('your changes to your course were approved');
  });

  it('Rejected: the escaped reason and the builder link; UPDATE says the live version stays', async () => {
    await new CourseRejectedMailerHandler(
      new FakeContacts(jane),
      new FakeTitles('Rust'),
      mailer,
      links,
    ).handle(rejected(), FAKE_TRX);
    const mail = mailer.sent[0];
    expect(mail?.subject).toBe('Your course update was not approved');
    expect(mail?.text).toContain(`Reason: ${REASON}`);
    expect(mail?.text).toContain('The currently published version stays live.');
    expect(mail?.html).toContain('&lt;b&gt;no audio&lt;/b&gt; &amp;');
    expect(mail?.html).not.toContain('<b>no audio');
    expect(mail?.text).toContain(
      `Open the course builder: http://localhost:3001/courses/${COURSE}`,
    );
  });

  it('skips quietly when the instructor no longer exists; dead-letters a too-short reason', async () => {
    const handler = new CourseRejectedMailerHandler(
      new FakeContacts(null),
      new FakeTitles('Rust'),
      mailer,
      links,
    );
    await handler.handle(rejected(), FAKE_TRX);
    expect(mailer.sent).toHaveLength(0);
    await expect(handler.handle(rejected({ reason: 'short' }), FAKE_TRX)).rejects.toBeInstanceOf(
      ZodError,
    );
  });
});

describe('TakedownMailerHandler', () => {
  let mailer: RecordingMailer;
  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('byAdmin: mails the live title, the escaped reason and the builder link', async () => {
    const titles = new FakeTitles('Rust');
    await new TakedownMailerHandler(new FakeContacts(jane), titles, mailer, links).handle(
      archived(),
      FAKE_TRX,
    );
    expect(titles.lookups).toEqual([`live:${COURSE}`]);
    const mail = mailer.sent[0];
    expect(mail).toMatchObject({
      to: 'jane@example.com',
      subject: 'Your course was taken down',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mail?.text).toContain('An administrator took down "Rust".');
    expect(mail?.text).toContain(`Reason: ${REASON}`);
    expect(mail?.html).not.toContain('<b>');
    expect(mail?.text).toContain(`http://localhost:3001/courses/${COURSE}`);
  });

  it("sends nothing for the owner's own archive", async () => {
    await new TakedownMailerHandler(
      new FakeContacts(jane),
      new FakeTitles('Rust'),
      mailer,
      links,
    ).handle(archived({ byAdmin: false, actorId: OWNER, reason: null }), FAKE_TRX);
    expect(mailer.sent).toHaveLength(0);
  });

  it('dead-letters a takedown without a reason (contract)', async () => {
    await expect(
      new TakedownMailerHandler(
        new FakeContacts(jane),
        new FakeTitles('Rust'),
        mailer,
        links,
      ).handle(archived({ reason: null }), FAKE_TRX),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
