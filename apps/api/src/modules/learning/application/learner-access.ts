import { Injectable } from '@nestjs/common';
import type { PlayerMode } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { CatalogFacade, type LiveCurriculum, type LiveCurriculumLecture } from '../../catalog';
import { EnrollmentFacade } from '../../enrollment';
import { CourseNotFound, EnrollmentRequired, LectureNotFound } from '../domain/learning.errors';
import { AccessCache } from './ports/access-cache';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a syntactically valid uuid (malformed ids never reach SQL). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Every lecture of a live curriculum, in curriculum order. */
export function liveLecturesOf(curriculum: LiveCurriculum): readonly LiveCurriculumLecture[] {
  return curriculum.sections.flatMap((section) => section.lectures);
}

/**
 * The common learner rule of every `/me/courses/:courseId/...` use case (design §5, §9 IDOR):
 *
 * 1. The course must have a live revision (PUBLISHED or ARCHIVED; archived courses stay
 *    playable for their learners, D13): else 404 `course_not_found`. A lecture must be part
 *    of that live revision: else 404 `lecture_not_found` (a lecture id of another course is
 *    "not found" through this course's path).
 * 2. An ACTIVE enrollment (`EnrollmentFacade.hasAccess`): else 403 `enrollment_required`.
 * 3. The owner without an enrollment gets a read-only PREVIEW bootstrap; owner writes are 403.
 *
 * Reads go to catalog's live curriculum (course row fresh, revision from the LRU), never the
 * working copy, and never a course the caller cannot see.
 */
@Injectable()
export class LearnerAccess {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly enrollment: EnrollmentFacade,
    private readonly accessCache: AccessCache,
  ) {}

  /** The live curriculum, or 404 `course_not_found`. */
  async curriculum(courseId: string, ex?: Executor): Promise<LiveCurriculum> {
    const curriculum = isUuid(courseId) ? await this.catalog.getLiveCurriculum(courseId, ex) : null;
    if (curriculum === null) throw new CourseNotFound();
    return curriculum;
  }

  /** The lecture of the live revision, or 404 `lecture_not_found`. */
  lecture(curriculum: LiveCurriculum, lectureId: string): LiveCurriculumLecture {
    const lecture = liveLecturesOf(curriculum).find((l) => l.id === lectureId.toLowerCase());
    if (lecture === undefined) throw new LectureNotFound();
    return lecture;
  }

  /**
   * LEARNER (ACTIVE enrollment, checked fresh) or PREVIEW (the owner), else 403. Refreshes the
   * heartbeat's access cache with the fresh answer.
   */
  async mode(userId: string, curriculum: LiveCurriculum): Promise<PlayerMode> {
    if (await this.freshAccess(userId, curriculum.courseId)) return 'LEARNER';
    if (curriculum.ownerId === userId) return 'PREVIEW';
    throw new EnrollmentRequired();
  }

  /** Writes: an ACTIVE enrollment, checked fresh (completions). Owners without one are 403. */
  async requireLearner(userId: string, courseId: string): Promise<void> {
    if (!(await this.freshAccess(userId, courseId))) throw new EnrollmentRequired();
  }

  /**
   * Heartbeats: an ACTIVE enrollment, through the 60 s access cache (`lrn:acc:{u}:{c}`). A
   * revocation is therefore seen within 60 s by the heartbeat path (accepted, design §5), and
   * at once by every fresh check.
   */
  async requireLearnerCached(userId: string, courseId: string): Promise<void> {
    const cached = await this.accessCache.get(userId, courseId);
    const hasAccess = cached ?? (await this.freshAccess(userId, courseId));
    if (!hasAccess) throw new EnrollmentRequired();
  }

  private async freshAccess(userId: string, courseId: string): Promise<boolean> {
    const hasAccess = await this.enrollment.hasAccess(userId, courseId);
    await this.accessCache.set(userId, courseId, hasAccess);
    return hasAccess;
  }
}
