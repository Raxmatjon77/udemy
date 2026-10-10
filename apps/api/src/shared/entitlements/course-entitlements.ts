import { Injectable } from '@nestjs/common';

/**
 * Injection token for the process-wide `CourseEntitlements` binding (catalog & media design
 * §1, §3). `Symbol.for` keeps the token identical if this file is ever loaded twice.
 *
 *   constructor(@Inject(COURSE_ENTITLEMENTS) private readonly entitlements: CourseEntitlements)
 */
export const COURSE_ENTITLEMENTS = Symbol.for('udemy.COURSE_ENTITLEMENTS');

/**
 * Port: "may this user consume the paid content of this course?" Catalog asks it when
 * authorizing playback of a non-preview lecture in a live course (design §5, playback).
 *
 * It lives in `shared` so the dependency is inverted: catalog depends on this interface,
 * Phase 4 `enrollment` implements it, and only AppModule knows both (no catalog -> enrollment
 * import, no cycle).
 */
export interface CourseEntitlements {
  /** True when `userId` has access to `courseId` (e.g. an active enrollment). */
  hasCourseAccess(userId: string, courseId: string): Promise<boolean>;
}

/**
 * Phase 2 binding: there are no enrollments yet, so nobody is entitled to a course. Owners,
 * moderators (`course:read:any`) and preview lectures are allowed by catalog itself, before
 * this port is consulted. Phase 4 replaces this binding with the enrollment-backed adapter.
 */
@Injectable()
export class DenyAllCourseEntitlements implements CourseEntitlements {
  hasCourseAccess(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
