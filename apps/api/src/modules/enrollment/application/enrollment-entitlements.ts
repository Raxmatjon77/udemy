import { Injectable } from '@nestjs/common';
import type { CourseEntitlements } from '../../../shared/entitlements';
import { isUuid } from './ids';
import { EnrollmentRepository } from './ports/enrollment.repository';

/**
 * The Phase 4 binding of the global `COURSE_ENTITLEMENTS` port (design §3, finding 5): a user
 * may watch the paid lectures of a course while they hold an ACTIVE enrollment in it, whatever
 * the course status (D13: archived courses stay watchable for enrolled students).
 *
 * Catalog's `LectureAccessAuthorizer` asks it on every non-preview playlist fetch of a viewer
 * who is not the owner, so it is ONE index lookup. It depends on the enrollment repository
 * only, never on `CatalogFacade`: the provider graph `LectureAccessAuthorizer ->
 * COURSE_ENTITLEMENTS -> EnrollmentEntitlements -> repository` has no cycle even though
 * EnrollmentModule imports CatalogModule. Bound in AppModule only:
 *
 *   CourseEntitlementsModule.forRoot({ imports: [EnrollmentModule], useExisting: EnrollmentEntitlements })
 */
@Injectable()
export class EnrollmentEntitlements implements CourseEntitlements {
  constructor(private readonly enrollments: EnrollmentRepository) {}

  hasCourseAccess(userId: string, courseId: string): Promise<boolean> {
    if (!isUuid(userId) || !isUuid(courseId)) return Promise.resolve(false);
    return this.enrollments.hasActive(userId, courseId);
  }
}
