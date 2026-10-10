/**
 * Media emails (design §7 `media.processing-failed-mailer`), rendered with the shared worker
 * layout: every interpolated value (filename, titles) is HTML-escaped, kept on one line, and
 * only http(s) links are rendered.
 */
import { MEDIA_FAILURE_LABELS, type MediaFailureCode, type MediaPurpose } from '@udemy/contracts';
import { oneLine, type RenderedMail, renderMail } from '../../shared/mail/mail-layout';
import type { FailedAssetPlacement } from '../persistence/failed-asset-context.reader';

const PURPOSE_NOUNS: Readonly<Record<MediaPurpose, string>> = {
  LECTURE_VIDEO: 'video',
  COURSE_THUMBNAIL: 'course image',
  LECTURE_RESOURCE: 'resource file',
};

export function processingFailedMail(input: {
  displayName: string;
  purpose: MediaPurpose;
  failureCode: MediaFailureCode;
  originalFilename: string | null;
  placement: FailedAssetPlacement | null;
  /** The course builder when `placement` is set, else "My courses". */
  actionUrl: string;
}): RenderedMail {
  const noun = PURPOSE_NOUNS[input.purpose];
  const file =
    input.originalFilename === null ? `your ${noun}` : `"${oneLine(input.originalFilename)}"`;
  const where = placementSentence(input.placement);
  return renderMail({
    subject: `We couldn't process your ${noun}`,
    greetingName: input.displayName,
    paragraphs: [
      `We could not process ${file}.${where === undefined ? '' : ` ${where}`}`,
      `What went wrong: ${MEDIA_FAILURE_LABELS[input.failureCode]}`,
      input.placement === null
        ? 'You can upload a new file from the course builder.'
        : 'Please upload a new file in the course builder.',
    ],
    action: {
      label: input.placement === null ? 'Open my courses' : 'Open the course builder',
      url: input.actionUrl,
    },
  });
}

function placementSentence(placement: FailedAssetPlacement | null): string | undefined {
  if (placement === null) return undefined;
  const course = oneLine(placement.courseTitle);
  return placement.kind === 'lecture'
    ? `It belongs to the lecture "${oneLine(placement.lectureTitle)}" in your course "${course}".`
    : `It is the course image of "${course}".`;
}
