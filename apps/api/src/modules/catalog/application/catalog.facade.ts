import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import { PublicCatalogRepository } from './ports/public-catalog.repository';

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
 * Public facade of the catalog context for other modules (design §3). Phase 2 has no
 * in-process consumer; these are the seams Phase 4 (commerce, enrollment) and Phase 5
 * (learning) need, and nothing more. Everything reads the LIVE revision, never the working
 * copy. Read methods take an optional executor so callers can read inside their transaction.
 */
@Injectable()
export class CatalogFacade {
  constructor(private readonly publicCatalog: PublicCatalogRepository) {}

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
