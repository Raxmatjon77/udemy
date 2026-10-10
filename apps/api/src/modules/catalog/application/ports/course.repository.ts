import type {
  BulletKind,
  CourseLanguage,
  CourseLevel,
  CourseStatus,
  CourseTransitionAction,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { CourseLifecycle } from '../../domain/course';

/** A non-deleted `catalog.courses` row (the working copy header and lifecycle pointers). */
export interface CourseRecord extends CourseLifecycle {
  readonly id: string;
  readonly ownerId: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly descriptionMd: string | null;
  /** Any tag of the DB shape; the app writes only `COURSE_LANGUAGES`. */
  readonly language: CourseLanguage | null;
  readonly level: CourseLevel | null;
  readonly categoryId: string | null;
  readonly thumbnailAssetId: string | null;
  readonly status: CourseStatus;
  readonly version: number;
  readonly pendingRevisionId: string | null;
  readonly publishedRevisionId: string | null;
  readonly firstPublishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewCourse {
  readonly ownerId: string;
  readonly slug: string;
  readonly title: string;
  readonly categoryId: string | null;
}

/**
 * Header fields to change (undefined = keep; null = clear). Every update bumps `version`.
 * `thumbnailAssetId` is written only by the thumbnail use cases (after MediaFacade).
 */
export interface CourseHeaderPatch {
  readonly title?: string;
  readonly subtitle?: string | null;
  readonly descriptionMd?: string | null;
  readonly language?: CourseLanguage | null;
  readonly level?: CourseLevel | null;
  readonly categoryId?: string | null;
  readonly slug?: string;
  readonly thumbnailAssetId?: string | null;
}

export interface CourseBullets {
  readonly outcomes: readonly string[];
  readonly requirements: readonly string[];
}

/** Keyset of "My courses": `(updated_at DESC, id DESC)`, exact timestamp text (design §14). */
export interface MyCoursesKeyset {
  readonly updatedAt: string;
  readonly id: string;
}

export interface MyCourseRecord {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: CourseStatus;
  readonly pendingRevisionId: string | null;
  readonly publishedRevisionId: string | null;
  readonly thumbnailAssetId: string | null;
  readonly firstPublishedAt: Date | null;
  readonly updatedAt: Date;
  /** `updated_at` as exact UTC text with microseconds (the keyset). */
  readonly updatedAtText: string;
  /** Action at the head of the transition chain (for the badge). */
  readonly headAction: CourseTransitionAction | null;
}

/**
 * A lifecycle change of the course row (status and revision pointers; undefined = keep).
 * Always bumps `version`. `markFirstPublished` sets `first_published_at = COALESCE(
 * first_published_at, now())`, i.e. the first APPROVE's `occurred_at` (same transaction).
 */
export interface LifecycleChange {
  readonly status: CourseStatus;
  readonly pendingRevisionId?: string | null;
  readonly publishedRevisionId?: string;
  readonly markFirstPublished?: boolean;
}

/** One row of the admin course list (working-copy title). */
export interface AdminCourseRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: CourseStatus;
  readonly pendingRevisionId: string | null;
  readonly publishedRevisionId: string | null;
  readonly firstPublishedAt: Date | null;
  readonly updatedAt: Date;
  /** `updated_at` as exact UTC text with microseconds (the keyset). */
  readonly updatedAtText: string;
  readonly headAction: CourseTransitionAction | null;
}

export interface AdminCourseQuery {
  readonly status: CourseStatus | undefined;
  /** Substring of the working title or the slug (>= 3 characters; LIKE-escaped). */
  readonly q: string | undefined;
  readonly ownerId: string | undefined;
  readonly after: MyCoursesKeyset | null;
  readonly limit: number;
}

/**
 * The course working copy (`catalog.courses` + `catalog.course_bullets`). Deleted courses are
 * invisible to every method. Writers take the caller's transaction, which already holds the
 * per-course row lock (`lockForUpdate`).
 */
export abstract class CourseRepository {
  /**
   * The per-course mutex of design §5: `SELECT ... WHERE id = $1 AND deleted_at IS NULL
   * FOR NO KEY UPDATE`. First statement of every course write (lock order: course -> category
   * -> assets). Null when the course does not exist (or is deleted).
   */
  abstract lockForUpdate(trx: Transaction<DB>, courseId: string): Promise<CourseRecord | null>;

  abstract findById(courseId: string, ex?: Executor): Promise<CourseRecord | null>;

  /** Owner of a non-deleted course (the `course` ownership resolver). */
  abstract findOwnerId(courseId: string): Promise<string | null>;

  /** Slugs of non-deleted courses starting with `prefix` (slug candidates, D12). */
  abstract findSlugsWithPrefix(ex: Executor, prefix: string): Promise<Set<string>>;

  /** Inserts a DRAFT course (version 1). Maps `courses_slug_active_uq` to SlugTaken. */
  abstract insert(trx: Transaction<DB>, course: NewCourse): Promise<CourseRecord>;

  /** Applies the patch and bumps `version`; returns the new row. */
  abstract updateHeader(
    trx: Transaction<DB>,
    courseId: string,
    patch: CourseHeaderPatch,
  ): Promise<CourseRecord>;

  /** Bumps `version` (and `updated_at`) after a child write (curriculum, bullets, article). */
  abstract bumpVersion(trx: Transaction<DB>, courseId: string): Promise<number>;

  /** Sets `deleted_at = now()` (same `now()` as the DELETE transition); returns it. */
  abstract markDeleted(trx: Transaction<DB>, courseId: string): Promise<Date>;

  abstract getBullets(courseId: string, ex?: Executor): Promise<CourseBullets>;

  /** Replaces one bullet list wholesale (delete + insert; the PK is deferrable). */
  abstract replaceBullets(
    trx: Transaction<DB>,
    courseId: string,
    kind: BulletKind,
    texts: readonly string[],
  ): Promise<void>;

  /** Applies a lifecycle change (P2-T10) and bumps `version`; returns the new row. */
  abstract applyLifecycle(
    trx: Transaction<DB>,
    courseId: string,
    change: LifecycleChange,
  ): Promise<CourseRecord>;

  /** Admin list: every non-deleted course, newest change first, with filters. */
  abstract searchForAdmin(query: AdminCourseQuery): Promise<AdminCourseRecord[]>;

  /** One page of the owner's non-deleted courses, newest change first. */
  abstract listByOwner(query: {
    readonly ownerId: string;
    readonly status: CourseStatus | undefined;
    readonly after: MyCoursesKeyset | null;
    readonly limit: number;
  }): Promise<MyCourseRecord[]>;
}
