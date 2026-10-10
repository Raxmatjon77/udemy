import { randomBytes, randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import { eventMessageId, SmtpMailer } from '@udemy/nest-common/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeConfig } from '../identity/testing/identity-mail.fakes';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import { seedDraftCourse } from '../testing/catalog-fixtures';
import {
  deleteMail,
  deleteMailMatching,
  deleteTestData,
  exactlyMails,
  insertTestUser,
  itSmtpHost,
  itSmtpPort,
  useIntegrationStack,
} from '../testing/integration';
import {
  CoursePublishedMailerHandler,
  CourseRejectedMailerHandler,
} from './handlers/course-decision-mailer.handlers';
import { ReviewRequestedMailerHandler } from './handlers/review-requested-mailer.handler';
import { TakedownMailerHandler } from './handlers/takedown-mailer.handler';
import { CatalogLinks } from './mail/catalog-links';
import { AdminRecipientsReader } from '../shared/mail/admin-recipients.reader';
import { CourseTitleReader } from './persistence/course-title.reader';

/**
 * The `catalog.course` mailers with their real adapters: Kysely against the dev Postgres
 * (admins from access.user_roles, titles from catalog.courses), SMTP to Mailpit and the real
 * idempotent processor. Events are built in memory with `it.`-prefixed consumer names, so a
 * running worker never sees them. Each delivers exactly once despite a redelivery.
 */
describe('catalog.course mailers (integration: Postgres + Mailpit)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];
  const emails: string[] = [];
  const subjects: string[] = [];
  const eventIds: string[] = [];
  let mailer: SmtpMailer | undefined;
  let processor: IdempotentEventProcessor;
  const handlers: Record<string, RegisteredEventHandler> = {};

  beforeAll(() => {
    if (it_.unavailableReason !== undefined) return;
    mailer = new SmtpMailer({
      host: itSmtpHost(),
      port: itSmtpPort(),
      from: 'Udemy Clone <no-reply@udemy.local>',
      pool: false,
    });
    const contacts = new UserContactReader();
    const titles = new CourseTitleReader();
    const links = new CatalogLinks(fakeConfig({ ADMIN_APP_ORIGIN: 'http://localhost:3002' }));
    const register = (
      eventType: string,
      name: string,
      handler: RegisteredEventHandler['handler'],
    ) => {
      handlers[eventType] = {
        topic: 'catalog.course',
        eventType,
        consumerName: `it.${name}`,
        handler,
      };
    };
    register(
      'CourseSubmittedForReview',
      'catalog.review-requested-mailer',
      new ReviewRequestedMailerHandler(new AdminRecipientsReader(), contacts, mailer, links),
    );
    register(
      'CoursePublished',
      'catalog.course-published-mailer',
      new CoursePublishedMailerHandler(contacts, titles, mailer, links),
    );
    register(
      'CourseRejected',
      'catalog.course-rejected-mailer',
      new CourseRejectedMailerHandler(contacts, titles, mailer, links),
    );
    register(
      'CourseArchived',
      'catalog.takedown-mailer',
      new TakedownMailerHandler(contacts, titles, mailer, links),
    );
    processor = new IdempotentEventProcessor(it_.db);
  });

  afterAll(async () => {
    mailer?.close();
    if (it_.unavailableReason !== undefined) return;
    if (eventIds.length > 0) {
      await it_.db.deleteFrom('outbox.processedEvents').where('eventId', 'in', eventIds).execute();
    }
    await deleteTestData(it_.db, userIds);
    await Promise.all(emails.map((e) => deleteMail(e)));
    // The review request also reached the dev stack's own admins: remove those by subject.
    await Promise.all(subjects.map((s) => deleteMailMatching(`subject:"${s}"`)));
  });

  async function user(
    tag: string,
    role?: 'ADMIN' | 'INSTRUCTOR',
  ): Promise<{ id: string; email: string }> {
    const created = await insertTestUser(it_.db, { tag, displayName: `${tag} <IT>`, role });
    userIds.push(created.id);
    emails.push(created.email);
    return created;
  }

  function envelope(eventType: string, courseId: string, payload: object): EventEnvelope {
    const eventId = randomUUID();
    eventIds.push(eventId);
    return {
      eventId,
      eventType,
      aggregateType: 'catalog.course',
      aggregateId: courseId,
      occurredAt: new Date().toISOString(),
      version: 1,
      payload,
    };
  }

  /** Processes the event twice (a Kafka redelivery): the second is a duplicate. */
  async function deliverTwice(event: EventEnvelope): Promise<void> {
    const registered = handlers[event.eventType];
    if (registered === undefined) throw new Error(`no handler for ${event.eventType}`);
    await expect(processor.process(registered, event)).resolves.toBe('processed');
    await expect(processor.process(registered, event)).resolves.toBe('duplicate');
  }

  const uniqueTitle = (prefix: string): string => `${prefix} ${randomBytes(4).toString('hex')}`;

  it('CourseSubmittedForReview -> exactly one mail per admin, with the admin review link', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const owner = await user('owner', 'INSTRUCTOR');
    const adminA = await user('admin', 'ADMIN');
    const adminB = await user('admin', 'ADMIN');
    const title = uniqueTitle('IT review');
    subjects.push(title);
    const courseId = randomUUID();
    const revisionId = randomUUID();
    const event = envelope('CourseSubmittedForReview', courseId, {
      courseId,
      revisionId,
      revisionNo: 1,
      ownerId: owner.id,
      kind: 'INITIAL',
      title,
      submittedAt: new Date().toISOString(),
    });

    await deliverTwice(event);

    for (const admin of [adminA, adminB]) {
      const mails = await exactlyMails(admin.email, 1);
      const mail = mails[0];
      expect(mail?.Subject).toBe(`Review requested: "${title}"`);
      expect(`<${mail?.MessageID}>`).toBe(eventMessageId(`${event.eventId}.${admin.id}`));
      expect(mail?.Text).toContain(
        `Open the review: http://localhost:3002/course-reviews/${revisionId}`,
      );
      expect(mail?.Text).toContain(`owner <IT> submitted a new course "${title}" for review`);
      expect(mail?.HTML).toContain(`href="http://localhost:3002/course-reviews/${revisionId}"`);
    }
    // The instructor is not an admin: nothing for them.
    await exactlyMails(owner.email, 0);
  }, 30_000);

  it('CoursePublished -> one mail to the instructor with the builder and public links', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const owner = await user('owner', 'INSTRUCTOR');
    const title = uniqueTitle('IT published');
    const { courseId, slug } = await seedDraftCourse(it_.db, { ownerId: owner.id, title });
    const event = envelope('CoursePublished', courseId, {
      courseId,
      revisionId: randomUUID(),
      revisionNo: 1,
      ownerId: owner.id,
      slug,
      kind: 'INITIAL',
      decidedBy: randomUUID(),
      publishedAt: new Date().toISOString(),
    });

    await deliverTwice(event);

    const mail = (await exactlyMails(owner.email, 1))[0];
    expect(mail?.Subject).toBe('Your course is live');
    expect(`<${mail?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mail?.Text).toContain(`"${title}" was approved and is now published`);
    expect(mail?.Text).toContain(`Public course page: http://localhost:3000/course/${slug}`);
    expect(mail?.Text).toContain(`Open your course: http://localhost:3001/courses/${courseId}`);
    expect(mail?.HTML).toContain(`href="http://localhost:3001/courses/${courseId}"`);
  }, 30_000);

  it('CourseRejected -> one mail with the escaped reason and the builder link', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const owner = await user('owner', 'INSTRUCTOR');
    const title = uniqueTitle('IT rejected');
    const { courseId } = await seedDraftCourse(it_.db, { ownerId: owner.id, title });
    const reason = 'Lecture 2 has <b>no audio</b> & needs a re-upload.';
    const event = envelope('CourseRejected', courseId, {
      courseId,
      revisionId: randomUUID(),
      ownerId: owner.id,
      kind: 'INITIAL',
      decidedBy: randomUUID(),
      reason,
      rejectedAt: new Date().toISOString(),
    });

    await deliverTwice(event);

    const mail = (await exactlyMails(owner.email, 1))[0];
    expect(mail?.Subject).toBe('Your course was not approved');
    expect(`<${mail?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mail?.Text).toContain(`We reviewed "${title}" and could not approve it yet.`);
    expect(mail?.Text).toContain(`Reason: ${reason}`);
    expect(mail?.HTML).toContain('Reason: Lecture 2 has &lt;b&gt;no audio&lt;/b&gt; &amp; needs');
    expect(mail?.Text).toContain(
      `Open the course builder: http://localhost:3001/courses/${courseId}`,
    );
  }, 30_000);

  it("CourseArchived byAdmin -> one takedown mail; the owner's own archive sends nothing", async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const owner = await user('owner', 'INSTRUCTOR');
    const title = uniqueTitle('IT takedown');
    const { courseId } = await seedDraftCourse(it_.db, { ownerId: owner.id, title });
    const reason = 'Copyrighted material in section 3 (reported twice).';
    const takedown = envelope('CourseArchived', courseId, {
      courseId,
      ownerId: owner.id,
      actorId: randomUUID(),
      byAdmin: true,
      reason,
      archivedAt: new Date().toISOString(),
    });
    const ownArchive = envelope('CourseArchived', courseId, {
      courseId,
      ownerId: owner.id,
      actorId: owner.id,
      byAdmin: false,
      reason: null,
      archivedAt: new Date().toISOString(),
    });

    await deliverTwice(takedown);
    await deliverTwice(ownArchive);

    const mail = (await exactlyMails(owner.email, 1))[0];
    expect(mail?.Subject).toBe('Your course was taken down');
    expect(`<${mail?.MessageID}>`).toBe(eventMessageId(takedown.eventId));
    expect(mail?.Text).toContain(`An administrator took down "${title}".`);
    expect(mail?.Text).toContain(`Reason: ${reason}`);
    expect(mail?.Text).toContain(`Open your course: http://localhost:3001/courses/${courseId}`);
  }, 30_000);
});
