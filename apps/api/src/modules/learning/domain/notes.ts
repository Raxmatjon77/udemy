import { LEARNING_LIMITS, type LectureType } from '@udemy/contracts';
import { validateMarkdown } from '@udemy/markdown/validate';
import { MarkdownNotAllowed, NoteLimitExceeded, NotePositionInvalid } from './learning.errors';

/*
 * Notes (design §4 `Note`, §5 `List/Create/Update/DeleteNote`, D9, D22): private markdown
 * (1–2000 characters, the request schema checks the length) keyed to a lecture of the live
 * curriculum, with an optional video timestamp. At most 500 per (user, course), counted under
 * the `note` two-int advisory lock (schema doc §10).
 */

/** What the position rule needs of a lecture. */
export interface NoteLecture {
  readonly type: LectureType;
  readonly durationSeconds: number | null;
}

/**
 * A timestamp is allowed on a VIDEO lecture only, within its duration (`null` / absent is
 * always fine). `lecture` is null when the note's lecture is no longer in the live revision:
 * only clearing the timestamp is possible then.
 *
 * @throws NotePositionInvalid (422 `validation_failed`)
 */
export function assertNotePosition(
  lecture: NoteLecture | null,
  positionSeconds: number | null | undefined,
): void {
  if (positionSeconds === null || positionSeconds === undefined) return;
  if (
    lecture === null ||
    lecture.type !== 'VIDEO' ||
    lecture.durationSeconds === null ||
    !Number.isInteger(positionSeconds) ||
    positionSeconds < 0 ||
    positionSeconds > lecture.durationSeconds
  ) {
    throw new NotePositionInvalid();
  }
}

/** @throws NoteLimitExceeded (422) once the course holds `LEARNING_LIMITS.maxNotesPerCourse` notes */
export function assertNoteCapacity(
  currentCount: number,
  limit: number = LEARNING_LIMITS.maxNotesPerCourse,
): void {
  if (currentCount >= limit) throw new NoteLimitExceeded(limit);
}

/**
 * User-generated markdown on the write path (D22): raw HTML, images and links other than
 * absolute http(s)/mailto are rejected with 422 `markdown_not_allowed`, one issue per offending
 * construct. The source is stored exactly as sent (same rules as Q&A and catalog).
 *
 * @throws MarkdownNotAllowed
 */
export function assertMarkdownAllowed(field: string, source: string): void {
  const result = validateMarkdown(source);
  if (result.ok) return;
  throw new MarkdownNotAllowed(
    result.issues.map((issue) => ({
      path: field,
      line: issue.line,
      column: issue.column,
      kind: issue.kind,
      construct: issue.construct,
      detail: issue.detail,
    })),
  );
}
