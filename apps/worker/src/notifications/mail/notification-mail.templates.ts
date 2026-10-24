/**
 * Notification e-mails (design D14, D22), one template per kind, rendered with the shared worker
 * layout (`renderMail`): every interpolated value is HTML-escaped, names and titles are kept on
 * one line, and only http(s) links are rendered. Payload texts are already plain-text snapshots
 * (markdown reduced by `markdownPlainText`), so no user markdown ever reaches an e-mail.
 *
 * MEDIA_READY / MEDIA_FAILED have no e-mail: they are in-app hints for the builder, and failures
 * keep their Phase 2 mail (`media.processing-failed-mailer`).
 */
import type { NotificationApp, NotificationContent } from '@udemy/contracts';
import { oneLine } from '../../shared/mail/mail-layout';

export interface NotificationMailContent {
  readonly subject: string;
  readonly paragraphs: readonly string[];
  readonly action: { readonly label: string; readonly url: string };
}

/** The links a template needs (`NotificationLinks` implements it). */
export interface NotificationMailUrls {
  learn(courseId: string): string;
  certificate(code: string): string;
  instructorQa(courseId: string): string;
  instructorCourse(courseId: string): string;
  adminModeration(): string;
}

const SUBJECT_NOUNS = {
  REVIEW: 'review',
  REVIEW_REPLY: 'reply to a review',
  QUESTION: 'question',
  ANSWER: 'answer',
} as const;

function quoted(text: string | null): string | undefined {
  return text === null ? undefined : `"${oneLine(text)}"`;
}

function present(...paragraphs: (string | undefined)[]): string[] {
  return paragraphs.filter((p): p is string => p !== undefined);
}

/** The e-mail of a notification, or null when the kind is in-app only. */
export function notificationMailContent(
  content: NotificationContent,
  app: NotificationApp,
  urls: NotificationMailUrls,
): NotificationMailContent | null {
  switch (content.kind) {
    case 'QA_NEW_QUESTION': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      return {
        subject: `New question in "${course}"`,
        paragraphs: present(
          `${p.authorName === null ? 'A student' : oneLine(p.authorName)} asked a question in your course "${course}":`,
          quoted(p.questionTitle),
        ),
        action: { label: 'Answer in Q&A', url: urls.instructorQa(p.courseId) },
      };
    }
    case 'QA_NEW_ANSWER': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      const who = p.byInstructor
        ? 'The instructor'
        : p.authorName === null
          ? 'Someone'
          : oneLine(p.authorName);
      return {
        subject: p.byInstructor
          ? `The instructor answered your question in "${course}"`
          : `New answer to your question in "${course}"`,
        paragraphs: present(
          p.questionTitle === null
            ? `${who} answered your question.`
            : `${who} answered your question "${oneLine(p.questionTitle)}":`,
          quoted(p.excerpt),
        ),
        action: {
          label: 'Open the discussion',
          url: app === 'INSTRUCTOR' ? urls.instructorQa(p.courseId) : urls.learn(p.courseId),
        },
      };
    }
    case 'QA_RESOLVED': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      return {
        subject: `Your answer was accepted in "${course}"`,
        paragraphs: [
          p.questionTitle === null
            ? `Your answer to a question in "${course}" was accepted.`
            : `Your answer to "${oneLine(p.questionTitle)}" in "${course}" was accepted.`,
        ],
        action: {
          label: 'Open the discussion',
          url: app === 'INSTRUCTOR' ? urls.instructorQa(p.courseId) : urls.learn(p.courseId),
        },
      };
    }
    case 'REVIEW_NEW': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      const who = p.reviewerName === null ? 'A student' : oneLine(p.reviewerName);
      return {
        subject:
          p.previousRating === null
            ? `New ${p.rating}-star review of "${course}"`
            : `A review of "${course}" changed to ${p.rating} stars`,
        paragraphs: present(
          p.previousRating === null
            ? `${who} rated your course "${course}" ${p.rating} out of 5.`
            : `${who} changed their rating of "${course}" from ${p.previousRating} to ${p.rating} out of 5.`,
          quoted(p.excerpt),
        ),
        action: { label: 'See your reviews', url: urls.instructorCourse(p.courseId) },
      };
    }
    case 'REVIEW_REPLY': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      return {
        subject: `The instructor replied to your review of "${course}"`,
        paragraphs: present(
          `${p.instructorName === null ? 'The instructor' : oneLine(p.instructorName)} replied to your review of "${course}":`,
          quoted(p.excerpt),
        ),
        action: { label: 'Open the course', url: urls.learn(p.courseId) },
      };
    }
    case 'ANNOUNCEMENT': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      return {
        subject:
          p.title === null ? `New announcement in "${course}"` : `${course}: ${oneLine(p.title)}`,
        paragraphs: present(
          `${p.authorName === null ? 'Your instructor' : oneLine(p.authorName)} posted an announcement in "${course}":`,
          quoted(p.title),
          'Read the full announcement in the course.',
        ),
        action: { label: 'Read the announcement', url: urls.learn(p.courseId) },
      };
    }
    case 'CERTIFICATE_ISSUED': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      return {
        subject: `Your certificate for "${course}" is ready`,
        paragraphs: [
          `Congratulations on completing "${course}"!`,
          `Your certificate code is ${p.code}. Anyone with the link can verify the certificate.`,
        ],
        action: { label: 'View your certificate', url: urls.certificate(p.code) },
      };
    }
    case 'MEDIA_READY':
    case 'MEDIA_FAILED':
      return null;
    case 'CONTENT_HIDDEN': {
      const p = content.payload;
      const course = oneLine(p.courseTitle);
      const noun = SUBJECT_NOUNS[p.subjectType];
      return {
        subject: `Your ${noun} was hidden`,
        paragraphs: [
          `Your ${noun} in "${course}" was hidden by moderation after it was reported.`,
          'It is no longer visible to other learners. If you think this was a mistake, contact support.',
        ],
        action: {
          label: 'Open the course',
          url: app === 'INSTRUCTOR' ? urls.instructorCourse(p.courseId) : urls.learn(p.courseId),
        },
      };
    }
    case 'MODERATION_QUEUE': {
      const p = content.payload;
      const noun = SUBJECT_NOUNS[p.subjectType];
      return {
        subject: `Content auto-hidden: a ${noun} (${p.openReportCount} reports)`,
        paragraphs: [
          `A ${noun} was hidden automatically after ${p.openReportCount} reports.`,
          'Please review it in the moderation queue: restore it or keep it hidden.',
        ],
        action: { label: 'Open the moderation queue', url: urls.adminModeration() },
      };
    }
  }
}
