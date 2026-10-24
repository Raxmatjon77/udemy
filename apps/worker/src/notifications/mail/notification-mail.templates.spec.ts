import { NOTIFICATION_KINDS, type NotificationContent } from '@udemy/contracts';
import { HmacUnsubscribeTokenCodec } from '@udemy/nest-common/unsubscribe';
import { describe, expect, it } from 'vitest';
import { renderMail } from '../../shared/mail/mail-layout';
import { notificationLinks, UNSUBSCRIBE_SECRET } from '../testing/notifications.fakes';
import { notificationMailContent } from './notification-mail.templates';

const ID = '01900000-0000-7000-8000-0000000000a1';
const COURSE = '01900000-0000-7000-8000-0000000000c1';
const links = notificationLinks();

const announcement: NotificationContent = {
  kind: 'ANNOUNCEMENT',
  payload: {
    announcementId: ID,
    courseId: COURSE,
    courseTitle: 'Rust <basics>',
    title: 'New "module" & quiz',
    authorName: 'Ina\nStructor',
    redacted: false,
  },
};

describe('notification mail templates', () => {
  it('every kind has a template decision (media kinds are in-app only)', () => {
    const noMail = NOTIFICATION_KINDS.filter(
      (kind) => kind === 'MEDIA_READY' || kind === 'MEDIA_FAILED',
    );
    expect(noMail).toEqual(['MEDIA_READY', 'MEDIA_FAILED']);
    expect(
      notificationMailContent(
        {
          kind: 'MEDIA_FAILED',
          payload: {
            assetId: ID,
            purpose: 'LECTURE_VIDEO',
            filename: null,
            failureCode: 'TOO_LONG',
          },
        },
        'INSTRUCTOR',
        links,
      ),
    ).toBeNull();
  });

  it('announcement: one-line names, escaped HTML, the course player link', () => {
    const content = notificationMailContent(announcement, 'STUDENT', links)!;
    expect(content.subject).toBe('Rust <basics>: New "module" & quiz');
    expect(content.paragraphs[0]).toBe('Ina Structor posted an announcement in "Rust <basics>":');
    expect(content.action.url).toBe(`http://localhost:3000/learn/${COURSE}`);
    const html = renderMail({ greetingName: 'A', ...content }).html;
    expect(html).toContain('&quot;Rust &lt;basics&gt;&quot;');
    expect(html).not.toContain('<basics>');
  });

  it('routes Q&A links by the recipient app', () => {
    const resolved: NotificationContent = {
      kind: 'QA_RESOLVED',
      payload: {
        questionId: ID,
        answerId: ID,
        courseId: COURSE,
        courseTitle: 'C',
        questionTitle: 'Q',
        redacted: false,
      },
    };
    expect(notificationMailContent(resolved, 'STUDENT', links)?.action.url).toBe(
      `http://localhost:3000/learn/${COURSE}`,
    );
    expect(notificationMailContent(resolved, 'INSTRUCTOR', links)?.action.url).toBe(
      `http://localhost:3001/qa?courseId=${COURSE}`,
    );
  });

  it('moderation queue links to the admin app', () => {
    const queue: NotificationContent = {
      kind: 'MODERATION_QUEUE',
      payload: { subjectType: 'REVIEW', subjectId: ID, courseId: COURSE, openReportCount: 3 },
    };
    expect(notificationMailContent(queue, 'ADMIN', links)).toMatchObject({
      subject: 'Content auto-hidden: a review (3 reports)',
      action: { url: 'http://localhost:3002/moderation' },
    });
  });
});

describe('NotificationLinks unsubscribe', () => {
  it('signs a token the shared codec verifies and builds the §14 header and footer URLs', () => {
    const token = links.unsubscribeToken(ID, 'ANNOUNCEMENTS')!;
    expect(new HmacUnsubscribeTokenCodec(UNSUBSCRIBE_SECRET).verify(token)).toEqual({
      userId: ID,
      category: 'ANNOUNCEMENTS',
    });
    expect(links.headers(token)).toEqual({
      'List-Unsubscribe': `<http://localhost:3000/api/notifications/unsubscribe?token=${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(links.footer(token, 'ANNOUNCEMENTS')).toEqual({
      url: `http://localhost:3000/unsubscribe#token=${token}`,
      preferencesUrl: 'http://localhost:3000/account/notifications',
      categoryLabel: 'course announcements',
    });
  });

  it('a locked category gets no token', () => {
    expect(links.unsubscribeToken(ID, 'MODERATION')).toBeNull();
  });
});
