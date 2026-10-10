import type { EventEnvelope } from '@udemy/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { FAKE_TRX, fakeConfig, RecordingMailer } from '../../identity/testing/identity-mail.fakes';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { EnrollmentLinks, instructorNewEnrollmentMail } from '../mail/enrollment-mail';
import { type EnrolledCourse, EnrolledCourseReader } from '../persistence/enrolled-course.reader';
import { InstructorNewEnrollmentMailerHandler } from './instructor-new-enrollment-mailer.handler';

const ENROLLMENT = '0199c8a0-0000-7000-8000-0000000000f1';
const COURSE = '0199c8a0-0000-7000-8000-0000000000c1';
const LINE = '0199c8a0-0000-7000-8000-0000000000b2';
const STUDENT = '0199c8a0-0000-7000-8000-000000000001';
const OWNER = '0199c8a0-0000-7000-8000-000000000002';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = '2026-10-10T10:00:00.000Z';

const granted = (overrides: Record<string, unknown> = {}): EventEnvelope => ({
  eventId: EVENT,
  eventType: 'EnrollmentGranted',
  aggregateType: 'enrollment.enrollment',
  aggregateId: ENROLLMENT,
  occurredAt: NOW,
  version: 1,
  payload: {
    enrollmentId: ENROLLMENT,
    userId: STUDENT,
    courseId: COURSE,
    source: 'ORDER',
    orderLineId: LINE,
    regrant: false,
    grantedAt: NOW,
    ...overrides,
  },
});

class FakeCourses extends EnrolledCourseReader {
  readonly lookups: string[] = [];
  constructor(private readonly course: EnrolledCourse | null) {
    super();
  }
  override async find(_trx: unknown, courseId: string): Promise<EnrolledCourse | null> {
    this.lookups.push(courseId);
    return this.course;
  }
}

class FakeContacts extends UserContactReader {
  readonly lookups: string[] = [];
  constructor(private readonly contact: UserContact | null) {
    super();
  }
  override async find(_trx: unknown, userId: string): Promise<UserContact | null> {
    this.lookups.push(userId);
    return this.contact;
  }
}

const owner: UserContact = { email: 'owner@example.com', displayName: 'Olga <Owner>' };
const course: EnrolledCourse = { ownerId: OWNER, title: 'Rust <for>\nEveryone' };

function handler(
  enabled: boolean,
  mailer: RecordingMailer,
  courses = new FakeCourses(course),
  contacts = new FakeContacts(owner),
) {
  const config = fakeConfig({ ENROLLMENT_INSTRUCTOR_MAIL_ENABLED: enabled });
  return new InstructorNewEnrollmentMailerHandler(
    config,
    courses,
    contacts,
    mailer,
    new EnrollmentLinks(config),
  );
}

describe('InstructorNewEnrollmentMailerHandler', () => {
  let mailer: RecordingMailer;
  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('flag off (the default): consumes the event, reads nothing, sends nothing', async () => {
    const courses = new FakeCourses(course);
    await handler(false, mailer, courses).handle(granted(), FAKE_TRX);
    expect(courses.lookups).toEqual([]);
    expect(mailer.sent).toHaveLength(0);
  });

  it('flag off still dead-letters a broken payload', async () => {
    await expect(
      handler(false, mailer).handle(granted({ orderLineId: null }), FAKE_TRX),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('flag on: mails the course owner with the builder link, Message-ID from the event', async () => {
    const contacts = new FakeContacts(owner);
    await handler(true, mailer, new FakeCourses(course), contacts).handle(granted(), FAKE_TRX);
    expect(contacts.lookups).toEqual([OWNER]);
    const mail = mailer.sent[0];
    expect(mail).toMatchObject({
      to: 'owner@example.com',
      subject: 'New enrollment in "Rust <for> Everyone"',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mail?.text).toContain(
      'A new student enrolled in "Rust <for> Everyone" with a purchase (2026-10-10 10:00 UTC).',
    );
    expect(mail?.text).toContain(`Open your course: http://localhost:3001/courses/${COURSE}`);
    expect(mail?.html).not.toContain('<for>');
    // No student data reaches the instructor.
    expect(mail?.text).not.toContain(STUDENT);
  });

  it('flag on: skips the owner enrolling in their own course, an unknown course or owner', async () => {
    await handler(true, mailer).handle(granted({ userId: OWNER }), FAKE_TRX);
    await handler(true, mailer, new FakeCourses(null)).handle(granted(), FAKE_TRX);
    await handler(true, mailer, new FakeCourses(course), new FakeContacts(null)).handle(
      granted(),
      FAKE_TRX,
    );
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('instructorNewEnrollmentMail', () => {
  it.each([
    ['FREE', false, 'A new student enrolled in "Go" for free'],
    ['ADMIN', false, 'A new student enrolled in "Go" through an administrator'],
    ['ORDER', true, 'A former student enrolled again in "Go" with a purchase'],
  ] as const)('%s (regrant %s)', (source, regrant, expected) => {
    const mail = instructorNewEnrollmentMail({
      displayName: 'Olga',
      courseTitle: 'Go',
      source,
      regrant,
      grantedAt: new Date(NOW),
      courseUrl: `http://localhost:3001/courses/${COURSE}`,
    });
    expect(mail.text).toContain(expected);
  });
});
