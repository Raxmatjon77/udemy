import { Injectable } from '@nestjs/common';
import type { Principal } from '../../../../shared/auth';
import { CatalogFacade } from '../../../catalog';
import { EnrollmentFacade } from '../../../enrollment';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * May this socket's principal join the course room `c:{courseId}` (design D17, §5 gateway
 * `subscribe`)? The room only carries id hints (`qa.changed`), and it mirrors who may read the
 * course's Q&A:
 *
 * - the course must have a live revision (PUBLISHED or ARCHIVED);
 * - student app: an ACTIVE enrollment (`EnrollmentFacade.hasAccess`) or the course owner;
 * - instructor app: the course owner only (an instructor token passes Q&A on owned courses);
 * - admin app: `course:read:any` (moderators).
 *
 * The principal is the socket's, fixed at the handshake (≤ 15 min old). A revoked enrollment
 * leaves the room through the worker's `socketsLeave` (`notifications.room-revoker`).
 *
 * Returns the canonical course id (the room name must match the worker's emits exactly), or
 * null when the principal may not join.
 */
@Injectable()
export class AuthorizeCourseRoomQuery {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly enrollments: EnrollmentFacade,
  ) {}

  async execute(principal: Principal, courseId: string): Promise<string | null> {
    if (!UUID.test(courseId)) return null;
    const course = await this.catalog.getPublishedCourse(courseId.toLowerCase());
    if (course === null) return null;
    return (await this.mayJoin(principal, course.id, course.ownerId)) ? course.id : null;
  }

  private async mayJoin(principal: Principal, courseId: string, ownerId: string): Promise<boolean> {
    switch (principal.app) {
      case 'admin':
        return principal.permissions.has('course:read:any');
      case 'instructor':
        return ownerId === principal.userId;
      case 'student':
        return (
          ownerId === principal.userId ||
          (await this.enrollments.hasAccess(principal.userId, courseId))
        );
    }
  }
}
