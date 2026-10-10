import {
  CURRICULUM_LIMITS,
  LECTURE_MEDIA_PURPOSE,
  type LectureType,
  type MediaPurpose,
  PREVIEWABLE_LECTURE_TYPES,
} from '@udemy/contracts';
import {
  CurriculumLimitExceeded,
  LectureTypeMismatch,
  OrderMismatch,
  PreviewNotAllowed,
} from './catalog.errors';

export { CURRICULUM_LIMITS };
export type { LectureType };

/* ----------------------------------------------------------------------------------------
 * Limits (design §4): ≤ 50 sections, ≤ 100 lectures per section, ≤ 500 per course,
 * ≤ 10 preview lectures. Checked under the course row lock, so counts cannot race.
 * -------------------------------------------------------------------------------------- */

/** @throws CurriculumLimitExceeded when a course already has the maximum number of sections */
export function assertCanAddSection(currentSections: number): void {
  if (currentSections >= CURRICULUM_LIMITS.maxSectionsPerCourse) {
    throw new CurriculumLimitExceeded(
      `A course can have at most ${CURRICULUM_LIMITS.maxSectionsPerCourse} sections.`,
    );
  }
}

/** @throws CurriculumLimitExceeded for the per-section or per-course lecture limit */
export function assertCanAddLecture(counts: {
  readonly inSection: number;
  readonly inCourse: number;
}): void {
  if (counts.inSection >= CURRICULUM_LIMITS.maxLecturesPerSection) {
    throw new CurriculumLimitExceeded(
      `A section can have at most ${CURRICULUM_LIMITS.maxLecturesPerSection} lectures.`,
    );
  }
  if (counts.inCourse >= CURRICULUM_LIMITS.maxLecturesPerCourse) {
    throw new CurriculumLimitExceeded(
      `A course can have at most ${CURRICULUM_LIMITS.maxLecturesPerCourse} lectures.`,
    );
  }
}

/* ----------------------------------------------------------------------------------------
 * Lecture type rules (invariants 3 and 4)
 * -------------------------------------------------------------------------------------- */

/**
 * The media purpose a lecture type accepts (VIDEO -> LECTURE_VIDEO, RESOURCE ->
 * LECTURE_RESOURCE).
 *
 * @throws LectureTypeMismatch for ARTICLE lectures (they have no media)
 */
export function mediaPurposeFor(type: LectureType): MediaPurpose {
  const purpose = LECTURE_MEDIA_PURPOSE[type];
  if (purpose === null) {
    throw new LectureTypeMismatch('Article lectures have no media; edit the article instead.');
  }
  return purpose;
}

/** @throws LectureTypeMismatch unless the lecture is an ARTICLE */
export function assertArticleLecture(type: LectureType): void {
  if (type !== 'ARTICLE') {
    throw new LectureTypeMismatch('Only article lectures have an article body.');
  }
}

export function isPreviewable(type: LectureType): boolean {
  return (PREVIEWABLE_LECTURE_TYPES as readonly LectureType[]).includes(type);
}

/**
 * Turning a lecture into a free preview: only VIDEO/ARTICLE, and at most 10 per course
 * (`previewsInCourse` counts the course's previews other than this lecture).
 *
 * @throws PreviewNotAllowed (422)
 */
export function assertCanBePreview(type: LectureType, previewsInCourse: number): void {
  if (!isPreviewable(type)) {
    throw new PreviewNotAllowed('Only video and article lectures can be a free preview.');
  }
  if (previewsInCourse >= CURRICULUM_LIMITS.maxPreviewLectures) {
    throw new PreviewNotAllowed(
      `A course can have at most ${CURRICULUM_LIMITS.maxPreviewLectures} free preview lectures.`,
    );
  }
}

/* ----------------------------------------------------------------------------------------
 * Whole-curriculum reorder (D3, invariant 5)
 * -------------------------------------------------------------------------------------- */

export interface CurriculumShape {
  /** Section ids in any order. */
  readonly sectionIds: readonly string[];
  /** Every lecture of the course (id + current section). */
  readonly lectureIds: readonly string[];
}

export interface RequestedSectionOrder {
  readonly sectionId: string;
  readonly lectureIds: readonly string[];
}

/** The new position of every section and lecture after a valid reorder. */
export interface CurriculumPositions {
  readonly sections: readonly { readonly id: string; readonly position: number }[];
  readonly lectures: readonly {
    readonly id: string;
    readonly sectionId: string;
    readonly position: number;
  }[];
}

function sameSet(current: readonly string[], requested: readonly string[]): boolean {
  if (current.length !== requested.length) return false;
  const requestedSet = new Set(requested);
  if (requestedSet.size !== requested.length) return false;
  return current.every((id) => requestedSet.has(id));
}

/**
 * Validates that `requested` is exactly a permutation of the current curriculum: every
 * current section exactly once, every current lecture exactly once (in any section), nothing
 * else. Lectures may move between sections. Returns the resulting contiguous positions.
 *
 * @throws OrderMismatch (409) for a stale or tampered order
 */
export function planCurriculumOrder(
  current: CurriculumShape,
  requested: readonly RequestedSectionOrder[],
): CurriculumPositions {
  const sectionIds = requested.map((s) => s.sectionId);
  if (!sameSet(current.sectionIds, sectionIds)) {
    throw new OrderMismatch({ detail: 'The sections do not match the current curriculum.' });
  }
  const lectureIds = requested.flatMap((s) => s.lectureIds);
  if (!sameSet(current.lectureIds, lectureIds)) {
    throw new OrderMismatch({ detail: 'The lectures do not match the current curriculum.' });
  }
  for (const section of requested) {
    if (section.lectureIds.length > CURRICULUM_LIMITS.maxLecturesPerSection) {
      throw new CurriculumLimitExceeded(
        `A section can have at most ${CURRICULUM_LIMITS.maxLecturesPerSection} lectures.`,
      );
    }
  }
  return {
    sections: requested.map((s, position) => ({ id: s.sectionId, position })),
    lectures: requested.flatMap((s) =>
      s.lectureIds.map((id, position) => ({ id, sectionId: s.sectionId, position })),
    ),
  };
}

/**
 * Validates a sibling reorder (categories): exactly a permutation of `current`.
 *
 * @throws OrderMismatch (409)
 */
export function planSiblingOrder(
  current: readonly string[],
  requested: readonly string[],
): { readonly id: string; readonly position: number }[] {
  if (!sameSet(current, requested)) {
    throw new OrderMismatch({ detail: 'The order does not match the current items.' });
  }
  return requested.map((id, position) => ({ id, position }));
}
