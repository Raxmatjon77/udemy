import {
  NOTIFICATION_KIND_META,
  NOTIFICATION_KINDS,
  type NotificationContent,
  redactNotificationPayload,
} from '@udemy/contracts';
import { HmacUnsubscribeTokenCodec } from '@udemy/nest-common/unsubscribe';
import { describe, expect, it } from 'vitest';
import { FAKE_TRX } from '../../identity/testing/identity-mail.fakes';
import { NonRetryableError } from '../../messaging';
import { testHandlerContext } from '../../testing/handler-context';
import { delivererKit, UNSUBSCRIBE_SECRET } from '../testing/notifications.fakes';
import { validateNotification } from './notification-deliverer';
import { effectiveChannels } from './notification-preferences.reader';
import { REDACTION_PATCHES } from './notification.store';
import { clampText, excerptOfMarkdown, excerptOfPlainText } from './text';

const USER = '01900000-0000-7000-8000-0000000000a1';
const OWNER = '01900000-0000-7000-8000-0000000000b1';
const COURSE = '01900000-0000-7000-8000-0000000000c1';
const QUESTION = '01900000-0000-7000-8000-0000000000d1';
const ANSWER = '01900000-0000-7000-8000-0000000000d2';
const EVENT = '01900000-0000-7000-8000-0000000000e1';

const SAMPLES: Record<string, NotificationContent> = {
  QA_NEW_QUESTION: {
    kind: 'QA_NEW_QUESTION',
    payload: {
      questionId: QUESTION,
      courseId: COURSE,
      courseTitle: 'Course',
      lectureId: null,
      questionTitle: 'Why?',
      authorName: 'Ann',
      redacted: false,
    },
  },
  QA_NEW_ANSWER: {
    kind: 'QA_NEW_ANSWER',
    payload: {
      questionId: QUESTION,
      answerId: ANSWER,
      courseId: COURSE,
      courseTitle: 'Course',
      questionTitle: 'Why?',
      authorName: 'Bob',
      byInstructor: false,
      excerpt: 'Because.',
      redacted: false,
    },
  },
  QA_RESOLVED: {
    kind: 'QA_RESOLVED',
    payload: {
      questionId: QUESTION,
      answerId: ANSWER,
      courseId: COURSE,
      courseTitle: 'Course',
      questionTitle: 'Why?',
      redacted: false,
    },
  },
  REVIEW_NEW: {
    kind: 'REVIEW_NEW',
    payload: {
      reviewId: QUESTION,
      courseId: COURSE,
      courseTitle: 'Course',
      rating: 4,
      previousRating: null,
      reviewerName: 'Ann',
      excerpt: 'Nice',
      redacted: false,
    },
  },
  REVIEW_REPLY: {
    kind: 'REVIEW_REPLY',
    payload: {
      reviewId: QUESTION,
      courseId: COURSE,
      courseTitle: 'Course',
      instructorName: 'Ina',
      excerpt: 'Thanks',
      redacted: false,
    },
  },
  ANNOUNCEMENT: {
    kind: 'ANNOUNCEMENT',
    payload: {
      announcementId: QUESTION,
      courseId: COURSE,
      courseTitle: 'Course',
      title: 'Hello',
      authorName: 'Ina',
      redacted: false,
    },
  },
};

describe('REDACTION_PATCHES', () => {
  it('covers exactly the redactable kinds of NOTIFICATION_KIND_META', () => {
    const redactable = NOTIFICATION_KINDS.filter((k) => NOTIFICATION_KIND_META[k].redactable);
    expect(Object.keys(REDACTION_PATCHES).sort()).toEqual([...redactable].sort());
  });

  it.each(Object.keys(REDACTION_PATCHES))(
    '%s: payload || patch = contracts redactNotificationPayload',
    (kind) => {
      const sample = SAMPLES[kind]!;
      const patch = {
        ...REDACTION_PATCHES[kind as keyof typeof REDACTION_PATCHES],
        redacted: true,
      };
      expect({ ...sample.payload, ...patch }).toEqual(redactNotificationPayload(sample).payload);
    },
  );
});

describe('effectiveChannels', () => {
  it('uses the code defaults without overrides', () => {
    expect(effectiveChannels('QA', [])).toEqual({ inApp: true, email: true });
    expect(effectiveChannels('COURSE_BUILDING', [])).toEqual({ inApp: true, email: false });
  });

  it('applies overrides per channel', () => {
    expect(effectiveChannels('ANNOUNCEMENTS', [{ channel: 'EMAIL', enabled: false }])).toEqual({
      inApp: true,
      email: false,
    });
    expect(effectiveChannels('QA', [{ channel: 'IN_APP', enabled: false }])).toEqual({
      inApp: false,
      email: true,
    });
  });

  it('keeps locked pairs on whatever a stray row says', () => {
    expect(
      effectiveChannels('MODERATION', [
        { channel: 'IN_APP', enabled: false },
        { channel: 'EMAIL', enabled: false },
      ]),
    ).toEqual({ inApp: true, email: true });
  });
});

describe('text helpers', () => {
  it('clamps by code points and marks the cut', () => {
    expect(clampText('abcdef', 6)).toBe('abcdef');
    expect(clampText('abcdefg', 6)).toBe('abcde…');
    expect(Array.from(clampText('😀'.repeat(300), 280))).toHaveLength(280);
  });

  it('excerpts plain text on one line, null when empty', () => {
    expect(excerptOfPlainText('  a\n\n b  ')).toBe('a b');
    expect(excerptOfPlainText('   ')).toBeNull();
    expect(excerptOfPlainText(null)).toBeNull();
  });

  it('reduces markdown to its visible text', () => {
    expect(excerptOfMarkdown('# Title\n\nSome **bold** [link](https://x.test) `code`')).toBe(
      'Title Some bold link code',
    );
  });
});

describe('validateNotification', () => {
  const base = {
    recipientId: USER,
    app: 'INSTRUCTOR' as const,
    kind: 'QA_NEW_QUESTION' as const,
    subjectId: QUESTION,
    sourceEventId: EVENT,
    payload: SAMPLES.QA_NEW_QUESTION!.payload as never,
  };

  it('accepts a valid delivery', () => {
    expect(validateNotification(base).kind).toBe('QA_NEW_QUESTION');
  });

  it('refuses the wrong app, a missing subject and a broken payload (non-retryable)', () => {
    expect(() => validateNotification({ ...base, app: 'STUDENT' })).toThrow(NonRetryableError);
    expect(() => validateNotification({ ...base, subjectId: null })).toThrow(NonRetryableError);
    expect(() =>
      validateNotification({
        ...base,
        payload: { ...SAMPLES.QA_NEW_QUESTION!.payload, courseId: 'x' } as never,
      }),
    ).toThrow(NonRetryableError);
    expect(() =>
      validateNotification({
        ...base,
        kind: 'CONTENT_HIDDEN',
        app: 'STUDENT',
        subjectId: QUESTION,
        payload: {
          subjectType: 'QUESTION',
          subjectId: QUESTION,
          courseId: COURSE,
          courseTitle: 'C',
        } as never,
      }),
    ).toThrow(NonRetryableError);
  });
});

describe('NotificationDeliverer', () => {
  const delivery = {
    recipientId: OWNER,
    app: 'INSTRUCTOR' as const,
    kind: 'QA_NEW_QUESTION' as const,
    subjectId: QUESTION,
    sourceEventId: EVENT,
    payload: SAMPLES.QA_NEW_QUESTION!.payload as never,
  };

  it('inserts the row, pushes after commit and mails with the RFC 8058 headers', async () => {
    const kit = delivererKit();
    kit.contacts.add(OWNER, 'Owner');
    const ctx = testHandlerContext();

    const outcome = await kit.deliverer.deliver(FAKE_TRX, ctx, delivery);

    expect(outcome).toMatchObject({ recipient: 'FOUND', inApp: 'CREATED', email: 'SENT' });
    expect(kit.store.rows).toHaveLength(1);
    expect(kit.realtime.emitted).toHaveLength(0); // nothing before the commit
    await ctx.runAfterCommit();
    expect(kit.realtime.emitted.map((e) => [e.room, e.event])).toEqual([
      [`u:${OWNER}:INSTRUCTOR`, 'notification.created'],
      [`u:${OWNER}:INSTRUCTOR`, 'notification.unread'],
    ]);

    const [mail] = kit.mailer.sent;
    expect(mail?.messageId).toBe(`<${EVENT}.qa_new_question.${OWNER}@udemy.local>`);
    const token = new HmacUnsubscribeTokenCodec(UNSUBSCRIBE_SECRET).sign({
      userId: OWNER,
      category: 'QA',
    });
    expect(mail?.headers).toEqual({
      'List-Unsubscribe': `<http://localhost:3000/api/notifications/unsubscribe?token=${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(mail?.text).toContain(`http://localhost:3000/unsubscribe#token=${token}`);
    expect(mail?.html).toContain(`href="http://localhost:3000/unsubscribe#token=${token}"`);
  });

  it('a replay (row exists) neither pushes nor mails again', async () => {
    const kit = delivererKit();
    kit.contacts.add(OWNER);
    await kit.deliverer.deliver(FAKE_TRX, testHandlerContext(), delivery);
    const ctx = testHandlerContext();

    const outcome = await kit.deliverer.deliver(FAKE_TRX, ctx, delivery);

    expect(outcome).toMatchObject({ inApp: 'EXISTS', email: 'SKIPPED' });
    expect(ctx.tasks).toHaveLength(0);
    expect(kit.mailer.sent).toHaveLength(1);
    expect(kit.store.rows).toHaveLength(1);
  });

  it('respects the preferences: IN_APP off still mails, EMAIL off only inserts', async () => {
    const kit = delivererKit();
    kit.contacts.add(OWNER);
    kit.preferences.set(OWNER, 'QA', 'IN_APP', false);
    expect(await kit.deliverer.deliver(FAKE_TRX, testHandlerContext(), delivery)).toMatchObject({
      inApp: 'OFF',
      email: 'SENT',
    });
    expect(kit.store.rows).toHaveLength(0);

    const other = delivererKit();
    other.contacts.add(OWNER);
    other.preferences.set(OWNER, 'QA', 'EMAIL', false);
    expect(await other.deliverer.deliver(FAKE_TRX, testHandlerContext(), delivery)).toMatchObject({
      inApp: 'CREATED',
      email: 'OFF',
    });
    expect(other.mailer.sent).toHaveLength(0);
  });

  it('moderation notices are locked on and carry no unsubscribe', async () => {
    const kit = delivererKit();
    kit.contacts.add(USER);
    kit.preferences.set(USER, 'MODERATION', 'EMAIL', false);
    await kit.deliverer.deliver(FAKE_TRX, testHandlerContext(), {
      recipientId: USER,
      app: 'STUDENT',
      kind: 'CONTENT_HIDDEN',
      subjectId: null,
      sourceEventId: EVENT,
      payload: {
        subjectType: 'QUESTION',
        subjectId: QUESTION,
        courseId: COURSE,
        courseTitle: 'Course',
      },
    });
    expect(kit.store.rows).toHaveLength(1);
    expect(kit.mailer.sent[0]?.headers).toBeUndefined();
    expect(kit.mailer.sent[0]?.text).not.toContain('Unsubscribe');
  });

  it('skips an unknown recipient', async () => {
    const kit = delivererKit();
    expect(await kit.deliverer.deliver(FAKE_TRX, testHandlerContext(), delivery)).toEqual({
      recipient: 'MISSING',
    });
    expect(kit.store.rows).toHaveLength(0);
  });

  it('media kinds have no e-mail', async () => {
    const kit = delivererKit();
    kit.contacts.add(OWNER);
    kit.preferences.set(OWNER, 'COURSE_BUILDING', 'EMAIL', true);
    const outcome = await kit.deliverer.deliver(FAKE_TRX, testHandlerContext(), {
      recipientId: OWNER,
      app: 'INSTRUCTOR',
      kind: 'MEDIA_READY',
      subjectId: QUESTION,
      sourceEventId: EVENT,
      payload: { assetId: QUESTION, purpose: 'LECTURE_VIDEO', filename: 'a.mp4' },
    });
    expect(outcome).toMatchObject({ inApp: 'CREATED', email: 'NONE' });
    expect(kit.mailer.sent).toHaveLength(0);
  });
});
