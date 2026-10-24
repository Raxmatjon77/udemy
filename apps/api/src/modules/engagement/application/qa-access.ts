import { Injectable } from '@nestjs/common';
import type { ClientApp } from '@udemy/contracts';
import { CatalogFacade } from '../../catalog';
import { EnrollmentFacade } from '../../enrollment';
import { CourseNotFound, EnrollmentRequired } from '../domain/engagement.errors';

/** The caller of a Q&A route (`qa:participate` exists in the student AND the instructor app). */
export interface QaViewer {
  readonly userId: string;
  readonly app: ClientApp;
}

/** A course whose Q&A the viewer may use. */
export interface QaCourse {
  readonly courseId: string;
  readonly ownerId: string;
  readonly isOwner: boolean;
}

/**
 * Who may read and post Q&A (design §5 "learner or owner", §8 Q&A, D9): the course must have a
 * live revision (PUBLISHED or ARCHIVED; else 404 `course_not_found`), and the caller must own
 * it or hold an ACTIVE enrollment (403 `enrollment_required`; the outline is public, so the
 * course's existence is no secret). An instructor-app token passes only on owned courses: the
 * instructor BFF is the owner's tool, learners use the student app. A revoked learner keeps
 * their posts (community value) but can no longer read or post.
 */
@Injectable()
export class QaAccess {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly enrollment: EnrollmentFacade,
  ) {}

  /** @throws CourseNotFound | EnrollmentRequired */
  async require(courseId: string, viewer: QaViewer): Promise<QaCourse> {
    const course = await this.catalog.getPublishedCourse(courseId);
    if (course === null) throw new CourseNotFound();
    if (course.ownerId === viewer.userId) {
      return { courseId: course.id, ownerId: course.ownerId, isOwner: true };
    }
    if (viewer.app !== 'student' || !(await this.enrollment.hasAccess(viewer.userId, course.id))) {
      throw new EnrollmentRequired();
    }
    return { courseId: course.id, ownerId: course.ownerId, isOwner: false };
  }

  /**
   * The same rule without errors, for reporters (ReportContent: Q&A content is reportable by
   * whoever can see it, from either app): null when the course is not live or the user is
   * neither its owner nor an active learner.
   */
  async visibleTo(courseId: string, userId: string): Promise<QaCourse | null> {
    const course = await this.catalog.getPublishedCourse(courseId);
    if (course === null) return null;
    const isOwner = course.ownerId === userId;
    if (!isOwner && !(await this.enrollment.hasAccess(userId, course.id))) return null;
    return { courseId: course.id, ownerId: course.ownerId, isOwner };
  }
}
