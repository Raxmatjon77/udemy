/**
 * Catalog moderation emails (design §7), rendered with the shared worker layout: every
 * interpolated value (titles, names, the admin's reason) is HTML-escaped, titles and names are
 * kept on one line, and only http(s) links are rendered.
 */
import type { RevisionKind } from '@udemy/contracts';
import { oneLine, type RenderedMail, renderMail, utc } from '../../shared/mail/mail-layout';

/** `"Title"` or a neutral fallback when the course row is gone. */
function courseName(title: string | null): string {
  return title === null ? 'your course' : `"${oneLine(title)}"`;
}

/** `catalog.review-requested-mailer`: one mail per admin. */
export function reviewRequestedMail(input: {
  adminName: string;
  ownerName: string | null;
  courseTitle: string;
  kind: RevisionKind;
  revisionNo: number;
  submittedAt: Date;
  reviewUrl: string;
}): RenderedMail {
  const title = `"${oneLine(input.courseTitle)}"`;
  const who = input.ownerName === null ? 'An instructor' : oneLine(input.ownerName);
  const what =
    input.kind === 'INITIAL'
      ? `a new course ${title}`
      : `an update to the published course ${title}`;
  return renderMail({
    subject: `Review requested: ${title}`,
    greetingName: input.adminName,
    paragraphs: [
      `${who} submitted ${what} for review (revision ${input.revisionNo}, ${utc(input.submittedAt)}).`,
      'Reviews are handled oldest first in the review queue.',
    ],
    action: { label: 'Open the review', url: input.reviewUrl },
  });
}

/** `catalog.course-published-mailer`. */
export function coursePublishedMail(input: {
  displayName: string;
  courseTitle: string | null;
  kind: RevisionKind;
  builderUrl: string;
  publicUrl: string;
}): RenderedMail {
  const name = courseName(input.courseTitle);
  const initial = input.kind === 'INITIAL';
  return renderMail({
    subject: initial ? 'Your course is live' : 'Your course update is live',
    greetingName: input.displayName,
    paragraphs: [
      initial
        ? `Good news: ${name} was approved and is now published in the catalog.`
        : `Good news: your changes to ${name} were approved and are now live.`,
      `Public course page: ${input.publicUrl}`,
    ],
    action: { label: 'Open your course', url: input.builderUrl },
  });
}

/** `catalog.course-rejected-mailer`: includes the admin's reason. */
export function courseRejectedMail(input: {
  displayName: string;
  courseTitle: string | null;
  kind: RevisionKind;
  reason: string;
  builderUrl: string;
}): RenderedMail {
  const name = courseName(input.courseTitle);
  const initial = input.kind === 'INITIAL';
  return renderMail({
    subject: initial ? 'Your course was not approved' : 'Your course update was not approved',
    greetingName: input.displayName,
    paragraphs: [
      initial
        ? `We reviewed ${name} and could not approve it yet.`
        : `We reviewed your changes to ${name} and could not approve them yet. The currently published version stays live.`,
      `Reason: ${input.reason.trim()}`,
      'Make the changes in the course builder and submit it for review again.',
    ],
    action: { label: 'Open the course builder', url: input.builderUrl },
  });
}

/** `catalog.takedown-mailer`: an admin archived (took down) a published course. */
export function courseTakedownMail(input: {
  displayName: string;
  courseTitle: string | null;
  reason: string;
  builderUrl: string;
}): RenderedMail {
  return renderMail({
    subject: 'Your course was taken down',
    greetingName: input.displayName,
    paragraphs: [
      `An administrator took down ${courseName(input.courseTitle)}. It is no longer listed in the catalog.`,
      `Reason: ${input.reason.trim()}`,
      'Contact support if you believe this is a mistake.',
    ],
    action: { label: 'Open your course', url: input.builderUrl },
  });
}
