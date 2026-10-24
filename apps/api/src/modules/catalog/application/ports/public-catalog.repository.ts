import type { CourseLanguage, CourseLevel, LectureType } from '@udemy/contracts';
import type { BrowseCursor, BrowseOptions, Executor } from '@udemy/db';
import type { CategoryRecord } from './category.repository';

/**
 * A course that has a live revision and is visible to someone: PUBLISHED, or ARCHIVED (kept
 * for its owner, moderators and, from Phase 4, enrolled students; D13). Never deleted.
 */
export interface LiveCourseRecord {
  readonly id: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly liveRevisionId: string;
  /** The live revision's thumbnail (NOT NULL in revisions; pinned READY at submit). */
  readonly thumbnailAssetId: string;
  readonly firstPublishedAt: Date;
  /** `occurred_at` of the APPROVE that made the live revision live. */
  readonly liveSince: Date;
}

/** A live course with its live revision's title (`CatalogFacade.getCourseSummaries`). */
export interface LiveCourseSummaryRecord extends LiveCourseRecord {
  readonly title: string;
}

/** One lecture as frozen in a revision (live or under review). */
export interface SnapshotLectureRecord {
  readonly revisionId: string;
  readonly lectureId: string;
  readonly type: LectureType;
  readonly title: string;
  readonly isPreview: boolean;
  readonly mediaAssetId: string | null;
  /** Loaded only when asked for (`withArticle`); null for other types. */
  readonly articleBodyMd: string | null;
}

/** A live course and, if the id is in its live revision, the lecture. */
export interface LiveLectureLookup {
  readonly course: LiveCourseRecord;
  readonly lecture: SnapshotLectureRecord | null;
}

/** A revision (any state) with its course, for moderator playback. */
export interface RevisionHeaderRecord {
  readonly revisionId: string;
  readonly courseId: string;
  readonly ownerId: string;
  readonly thumbnailAssetId: string;
}

/** One browse row: the PUBLISHED course and its live revision header. */
export interface BrowseRecord {
  readonly id: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly firstPublishedAt: Date;
  readonly title: string;
  readonly subtitle: string;
  readonly level: CourseLevel;
  readonly language: CourseLanguage;
  readonly categoryId: string;
  readonly thumbnailAssetId: string;
  /** Exact keyset of this row (microsecond text, design §14). */
  readonly cursor: BrowseCursor;
}

export interface LiveTotals {
  readonly lectureCount: number;
  readonly videoSeconds: number;
}

/**
 * Read model of the public catalog (design §5 "public read and playback"): everything comes
 * from LIVE revision snapshots (`courses.published_revision_id`), never the working copy.
 */
export abstract class PublicCatalogRepository {
  /** A PUBLISHED course by slug (the public landing never shows archived courses). */
  abstract findPublishedBySlug(slug: string, ex?: Executor): Promise<LiveCourseRecord | null>;

  /** A PUBLISHED or ARCHIVED course with a live revision. */
  abstract findLiveCourse(courseId: string, ex?: Executor): Promise<LiveCourseRecord | null>;

  /**
   * The PUBLISHED or ARCHIVED courses among `courseIds` (valid uuids), with their live title,
   * in one query. Ids without a live revision (draft, deleted, unknown) are absent; no order.
   */
  abstract findLiveCourseSummaries(
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<LiveCourseSummaryRecord[]>;

  /**
   * The live course and the lecture in its live revision (lecture null when the id is not in
   * it). Null when the course has no live revision (draft, deleted, unknown).
   */
  abstract findLiveLecture(
    courseId: string,
    lectureId: string,
    options: { readonly withArticle: boolean },
    ex?: Executor,
  ): Promise<LiveLectureLookup | null>;

  /** A revision header, or null. */
  abstract findRevisionHeader(
    revisionId: string,
    ex?: Executor,
  ): Promise<RevisionHeaderRecord | null>;

  /** One lecture of a revision, or null when the id is not part of it. */
  abstract findRevisionLecture(
    revisionId: string,
    lectureId: string,
    options: { readonly withArticle: boolean },
    ex?: Executor,
  ): Promise<SnapshotLectureRecord | null>;

  /** Lecture ids of the live revision in curriculum order (empty when not live). */
  abstract listLiveLectureIds(courseId: string, ex?: Executor): Promise<string[]>;

  /**
   * Ids of the owner's PUBLISHED or ARCHIVED courses (never deleted), most recently first
   * published first, at most `limit` (engagement's instructor Q&A inbox).
   */
  abstract listLiveCourseIdsByOwner(
    ownerId: string,
    limit: number,
    ex?: Executor,
  ): Promise<string[]>;

  /** Lecture count and total video seconds of each course's live revision. */
  abstract liveTotals(
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlyMap<string, LiveTotals>>;

  /** One browse page (`@udemy/db` `browsePublishedCourses`, exact-text keyset). */
  abstract browse(options: BrowseOptions, ex?: Executor): Promise<BrowseRecord[]>;

  /** Every category (inactive included), without usage counts. */
  abstract listCategories(ex?: Executor): Promise<CategoryRecord[]>;
}
