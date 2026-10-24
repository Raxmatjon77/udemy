import { NOTIFICATION_KIND_META, type Notification } from '@udemy/contracts';

import { certificateHref, learnCourseHref } from '../learning/links';

/**
 * How a notification reads in the bell (design D14). Payloads are point-in-time snapshots and
 * are always rendered as React text (never markup). A payload redacted by moderation has its
 * user-authored text set to null; the line then says so instead of quoting it.
 */
export interface NotificationView {
  title: string;
  text: string;
  /** Where clicking it goes, or null. */
  href: string | null;
}

const quoted = (text: string | null) => (text === null ? '(removed)' : `“${text}”`);

export function describeNotification(notification: Notification): NotificationView {
  const title = NOTIFICATION_KIND_META[notification.kind].label;
  switch (notification.kind) {
    case 'QA_NEW_ANSWER': {
      const p = notification.payload;
      const who = p.byInstructor ? 'The instructor' : (p.authorName ?? 'Someone');
      return {
        title,
        text: `${who} answered ${quoted(p.questionTitle)} in ${p.courseTitle}.`,
        href: learnCourseHref(p.courseId),
      };
    }
    case 'QA_RESOLVED': {
      const p = notification.payload;
      return {
        title,
        text: `Your answer to ${quoted(p.questionTitle)} in ${p.courseTitle} was accepted.`,
        href: learnCourseHref(p.courseId),
      };
    }
    case 'QA_NEW_QUESTION': {
      const p = notification.payload;
      return {
        title,
        text: `${p.authorName ?? 'A student'} asked ${quoted(p.questionTitle)} in ${p.courseTitle}.`,
        href: null,
      };
    }
    case 'REVIEW_REPLY': {
      const p = notification.payload;
      return {
        title,
        text: `${p.instructorName ?? 'The instructor'} replied to your review of ${p.courseTitle}.`,
        href: learnCourseHref(p.courseId),
      };
    }
    case 'REVIEW_NEW': {
      const p = notification.payload;
      return { title, text: `${p.rating}-star review of ${p.courseTitle}.`, href: null };
    }
    case 'ANNOUNCEMENT': {
      const p = notification.payload;
      return {
        title,
        text: `${p.courseTitle}: ${p.title ?? '(removed)'}`,
        href: learnCourseHref(p.courseId),
      };
    }
    case 'CERTIFICATE_ISSUED': {
      const p = notification.payload;
      return {
        title,
        text: `Your certificate for ${p.courseTitle} is ready.`,
        href: certificateHref(p.code),
      };
    }
    case 'CONTENT_HIDDEN': {
      const p = notification.payload;
      return {
        title,
        text: `Moderators hid one of your posts in ${p.courseTitle}.`,
        href: null,
      };
    }
    case 'MEDIA_READY':
    case 'MEDIA_FAILED':
    case 'MODERATION_QUEUE':
      return { title, text: title, href: null };
  }
}
