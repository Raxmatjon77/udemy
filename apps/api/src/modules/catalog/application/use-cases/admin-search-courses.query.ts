import { Injectable } from '@nestjs/common';
import type { AdminCoursePage, CourseStatus } from '@udemy/contracts';
import { courseBadge } from '../../domain/course';
import { decodeMyCoursesCursor, encodeMyCoursesCursor } from '../course-cursor';
import { CoursePeopleDirectory } from '../ports/course-people.directory';
import { CourseRepository } from '../ports/course.repository';
import { UNKNOWN_PERSON } from './get-course-history.query';

export interface AdminSearchCoursesInput {
  readonly status?: CourseStatus;
  readonly q?: string;
  readonly ownerId?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * `AdminSearchCourses` (admin, design §5/§8): every non-deleted course, newest change first
 * (keyset `(updated_at DESC, id DESC)` on the exact timestamp text), filtered by status, owner
 * and a title/slug substring, with the derived badge and the owner's ban flag (§13 Q4: banned
 * instructors' courses are taken down manually from this list). ARCHIVED rows carry who archived
 * the course and why (the latest ARCHIVE transition); admins see every actor by name.
 */
@Injectable()
export class AdminSearchCoursesQuery {
  constructor(
    private readonly courses: CourseRepository,
    private readonly people: CoursePeopleDirectory,
  ) {}

  async execute(input: AdminSearchCoursesInput): Promise<AdminCoursePage> {
    const after = input.cursor === undefined ? null : decodeMyCoursesCursor(input.cursor);
    const rows = await this.courses.searchForAdmin({
      status: input.status,
      q: input.q,
      ownerId: input.ownerId,
      after,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const people = await this.people.findPeople(
      page.flatMap((r) => (r.archive === null ? [r.ownerId] : [r.ownerId, r.archive.actorId])),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const owner = people.get(row.ownerId);
        return {
          id: row.id,
          slug: row.slug,
          title: row.title,
          status: row.status,
          badge: courseBadge(row, row.headAction),
          owner: {
            id: row.ownerId,
            displayName: owner?.displayName ?? UNKNOWN_PERSON,
            banned: owner?.banned ?? false,
          },
          pendingRevisionId: row.pendingRevisionId,
          liveRevisionId: row.publishedRevisionId,
          firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
          updatedAt: row.updatedAt.toISOString(),
          archivedBy:
            row.archive === null
              ? null
              : {
                  id: row.archive.actorId,
                  displayName: people.get(row.archive.actorId)?.displayName ?? UNKNOWN_PERSON,
                  // Only the owner and admins can archive (design §5): anyone else is a moderator.
                  isModerator: row.archive.actorId !== row.ownerId,
                },
          archiveReason: row.archive?.reason ?? null,
        };
      }),
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? encodeMyCoursesCursor({ updatedAt: last.updatedAtText, id: last.id })
          : null,
    };
  }
}
