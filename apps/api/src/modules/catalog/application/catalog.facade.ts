import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import { MediaFacade } from '../../media';
import { PublicCatalogRepository } from './ports/public-catalog.repository';
import { isServableThumbnail } from './public-catalog-support';

/** At most this many ids per `getCourseSummaries` call (a cart holds 20, a page 48). */
export const COURSE_SUMMARIES_MAX_IDS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A course with a live revision, as other contexts see it (design §3 `CourseSummary`). */
export interface PublishedCourseSummary {
  readonly id: string;
  readonly slug: string;
  readonly ownerId: string;
  /**
   * `PUBLISHED`: listed and sellable. `ARCHIVED`: hidden from the catalog, but its live
   * revision stays readable for the owner, moderators and entitled users (D13).
   */
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly liveRevisionId: string;
  readonly firstPublishedAt: Date;
}

/**
 * What commerce (cart, order-line snapshots) and enrollment ("My learning") show of a course
 * (commerce & enrollment design §3): the LIVE revision's title, never the working copy's.
 */
export interface CourseSummary {
  readonly id: string;
  readonly slug: string;
  readonly ownerId: string;
  /** `PUBLISHED`: sellable. `ARCHIVED`: not for sale, still shown to enrolled users (D13). */
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly liveRevisionId: string;
  /** The live revision's title (what was approved; what an order line snapshots). */
  readonly title: string;
  /** The live thumbnail can be served (READY, not purged, has the w750 rendition). */
  readonly hasThumbnail: boolean;
}

/**
 * Public facade of the catalog context for other modules (design §3). Phase 2 has no
 * in-process consumer; these are the seams Phase 4 (commerce, enrollment) and Phase 5
 * (learning) need, and nothing more. Everything reads the LIVE revision, never the working
 * copy. Read methods take an optional executor so callers can read inside their transaction.
 */
@Injectable()
export class CatalogFacade {
  constructor(
    private readonly publicCatalog: PublicCatalogRepository,
    private readonly media: MediaFacade,
  ) {}

  /**
   * Batch read for commerce and enrollment (two queries, whatever the count): the PUBLISHED
   * or ARCHIVED courses among `courseIds`, in the order of their first occurrence. Unknown,
   * malformed, never-published and deleted ids are omitted (callers report them as
   * unavailable). Commerce sells only `status === 'PUBLISHED'`.
   *
   * @throws RangeError for more than `COURSE_SUMMARIES_MAX_IDS` distinct ids (a caller bug).
   */
  async getCourseSummaries(courseIds: readonly string[], ex?: Executor): Promise<CourseSummary[]> {
    const ids = [...new Set(courseIds)];
    if (ids.length > COURSE_SUMMARIES_MAX_IDS) {
      throw new RangeError(
        `getCourseSummaries: ${ids.length} ids (at most ${COURSE_SUMMARIES_MAX_IDS})`,
      );
    }
    const valid = ids.filter((id) => UUID.test(id));
    if (valid.length === 0) return [];
    const courses = await this.publicCatalog.findLiveCourseSummaries(valid, ex);
    if (courses.length === 0) return [];
    const thumbnails = await this.media.getAssets(
      courses.map((c) => c.thumbnailAssetId),
      ex,
    );
    const servable = new Set(thumbnails.filter(isServableThumbnail).map((a) => a.id));
    const byId = new Map(courses.map((c) => [c.id, c]));
    return valid.flatMap((id): CourseSummary[] => {
      const course = byId.get(id);
      if (course === undefined) return [];
      return [
        {
          id: course.id,
          slug: course.slug,
          ownerId: course.ownerId,
          status: course.status,
          liveRevisionId: course.liveRevisionId,
          title: course.title,
          hasThumbnail: servable.has(course.thumbnailAssetId),
        },
      ];
    });
  }

  /**
   * The course if it has a live revision (PUBLISHED or ARCHIVED, never deleted), else null.
   * Commerce: sell only when `status === 'PUBLISHED'`.
   */
  async getPublishedCourse(
    courseId: string,
    ex?: Executor,
  ): Promise<PublishedCourseSummary | null> {
    const course = await this.publicCatalog.findLiveCourse(courseId, ex);
    if (course === null) return null;
    return {
      id: course.id,
      slug: course.slug,
      ownerId: course.ownerId,
      status: course.status,
      liveRevisionId: course.liveRevisionId,
      firstPublishedAt: course.firstPublishedAt,
    };
  }

  /**
   * Whether `lectureId` is part of the course's CURRENT live revision (learning: accept
   * progress only for lectures a student can actually see). False for unknown courses.
   */
  async lectureBelongsToLiveRevision(
    courseId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<boolean> {
    const found = await this.publicCatalog.findLiveLecture(
      courseId,
      lectureId,
      { withArticle: false },
      ex,
    );
    return found?.lecture != null;
  }

  /** Lecture ids of the live revision in curriculum order (progress denominator); [] if none. */
  getLiveLectureIds(courseId: string, ex?: Executor): Promise<string[]> {
    return this.publicCatalog.listLiveLectureIds(courseId, ex);
  }
}
