import { Injectable } from '@nestjs/common';
import type { CourseHistoryActor, CourseHistoryResponse } from '@udemy/contracts';
import { CourseNotFound } from '../../domain/catalog.errors';
import { CoursePeopleDirectory, type CoursePerson } from '../ports/course-people.directory';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';

export interface GetCourseHistoryInput {
  readonly courseId: string;
  /** The viewer holds `course:read:any` (an admin): every actor is shown by name. */
  readonly viewerIsModerator: boolean;
}

/** Shown for a user that no longer exists (ids are kept forever in the log). */
export const UNKNOWN_PERSON = 'Unknown user';
/** How instructors see admins (design §5 GetCourseHistory). */
export const MODERATOR_LABEL = 'Moderator';

/**
 * `GetCourseHistory` (owner or admin, design §5): the transition chain oldest first with actor
 * display names. Only the owner and admins can act on a course, so any non-owner actor is a
 * moderator; instructors see them as "Moderator" without an id.
 */
@Injectable()
export class GetCourseHistoryQuery {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly people: CoursePeopleDirectory,
  ) {}

  async execute(input: GetCourseHistoryInput): Promise<CourseHistoryResponse> {
    const course = await this.courses.findById(input.courseId);
    if (course === null) throw new CourseNotFound();
    const records = await this.lifecycle.listHistory(course.id);
    const people = await this.people.findPeople(records.map((r) => r.actorId));

    const actor = (actorId: string): CourseHistoryActor => {
      const isModerator = actorId !== course.ownerId;
      if (isModerator && !input.viewerIsModerator) {
        return { id: null, displayName: MODERATOR_LABEL, isModerator };
      }
      const person: CoursePerson | undefined = people.get(actorId);
      return { id: actorId, displayName: person?.displayName ?? UNKNOWN_PERSON, isModerator };
    };

    return {
      items: records.map((r) => ({
        id: r.id,
        action: r.action,
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        revisionId: r.revisionId,
        revisionNo: r.revisionNo,
        actor: actor(r.actorId),
        reason: r.reason,
        occurredAt: r.occurredAt.toISOString(),
      })),
    };
  }
}
