import type { LectureType } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { CurriculumPositions } from '../../domain/curriculum';

export interface SectionRecord {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly objective: string | null;
  readonly position: number;
  readonly updatedAt: Date;
}

export interface LectureRecord {
  readonly id: string;
  readonly courseId: string;
  readonly sectionId: string;
  readonly type: LectureType;
  readonly title: string;
  readonly descriptionMd: string | null;
  readonly isPreview: boolean;
  readonly position: number;
  readonly mediaAssetId: string | null;
  readonly updatedAt: Date;
}

export interface ArticleRecord {
  readonly lectureId: string;
  readonly bodyMd: string;
  readonly updatedAt: Date;
}

/** A lecture that holds a media asset (for releasing usages, ascending asset id). */
export interface LectureMediaRef {
  readonly lectureId: string;
  readonly assetId: string;
}

export interface SectionPatch {
  readonly title?: string;
  readonly objective?: string | null;
}

export interface LecturePatch {
  readonly title?: string;
  readonly descriptionMd?: string | null;
  readonly isPreview?: boolean;
}

/**
 * Sections, lectures and article bodies of a course working copy. EVERY child lookup is
 * scoped by `courseId` (design finding 2 / Q7): a section or lecture of another course is
 * simply not found, which keeps the nested routes IDOR-safe without per-child permissions.
 *
 * Writers run in the caller's transaction, which holds the course row lock; positions stay
 * contiguous `0..n-1` (deferred uniques let one statement permute them).
 */
export abstract class CurriculumRepository {
  /** Sections in order. */
  abstract listSections(courseId: string, ex?: Executor): Promise<SectionRecord[]>;

  /** Every lecture of the course, ordered by section position then lecture position. */
  abstract listLectures(courseId: string, ex?: Executor): Promise<LectureRecord[]>;

  /** Article bodies of the course's ARTICLE lectures, by lecture id. */
  abstract listArticleBodies(courseId: string, ex?: Executor): Promise<Map<string, string>>;

  abstract findSection(
    courseId: string,
    sectionId: string,
    ex?: Executor,
  ): Promise<SectionRecord | null>;

  abstract findLecture(
    courseId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<LectureRecord | null>;

  abstract countSections(trx: Transaction<DB>, courseId: string): Promise<number>;

  abstract countLectures(
    trx: Transaction<DB>,
    courseId: string,
    sectionId: string,
  ): Promise<{ inSection: number; inCourse: number }>;

  /** Preview lectures of the course, excluding `exceptLectureId`. */
  abstract countPreviews(
    trx: Transaction<DB>,
    courseId: string,
    exceptLectureId: string,
  ): Promise<number>;

  /** Lectures with media (of one section, or the whole course), ascending by asset id. */
  abstract listLectureMedia(
    trx: Transaction<DB>,
    courseId: string,
    sectionId?: string,
  ): Promise<LectureMediaRef[]>;

  abstract insertSection(
    trx: Transaction<DB>,
    section: { courseId: string; title: string; objective: string | null; position: number },
  ): Promise<SectionRecord>;

  abstract updateSection(
    trx: Transaction<DB>,
    courseId: string,
    sectionId: string,
    patch: SectionPatch,
  ): Promise<SectionRecord>;

  /** Deletes the section's lectures (articles cascade), the section, and closes the gap. */
  abstract deleteSection(trx: Transaction<DB>, courseId: string, sectionId: string): Promise<void>;

  abstract insertLecture(
    trx: Transaction<DB>,
    lecture: {
      courseId: string;
      sectionId: string;
      type: LectureType;
      title: string;
      position: number;
    },
  ): Promise<LectureRecord>;

  abstract updateLecture(
    trx: Transaction<DB>,
    courseId: string,
    lectureId: string,
    patch: LecturePatch,
  ): Promise<LectureRecord>;

  /** Sets or clears `media_asset_id` (after MediaFacade use/release). */
  abstract setLectureMedia(
    trx: Transaction<DB>,
    courseId: string,
    lectureId: string,
    assetId: string | null,
  ): Promise<LectureRecord>;

  /** Clears `media_asset_id` of every lecture of the course (DeleteCourse, schema doc §6 item 6). */
  abstract clearAllLectureMedia(trx: Transaction<DB>, courseId: string): Promise<void>;

  /** Deletes one lecture (its article cascades) and closes the gap in its section. */
  abstract deleteLecture(trx: Transaction<DB>, courseId: string, lectureId: string): Promise<void>;

  /** Rewrites every section and lecture position (and lecture section) of a valid reorder. */
  abstract applyPositions(
    trx: Transaction<DB>,
    courseId: string,
    positions: CurriculumPositions,
  ): Promise<void>;

  abstract findArticle(lectureId: string, ex?: Executor): Promise<ArticleRecord | null>;

  /** Inserts or replaces the body (the source is stored verbatim). */
  abstract saveArticle(
    trx: Transaction<DB>,
    lectureId: string,
    bodyMd: string,
  ): Promise<ArticleRecord>;
}
