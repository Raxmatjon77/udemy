import { Injectable } from '@nestjs/common';
import type { CourseStatus, MyCoursePage } from '@udemy/contracts';
import { courseBadge } from '../../domain/course';
import { decodeMyCoursesCursor, encodeMyCoursesCursor } from '../course-cursor';
import { CourseRepository } from '../ports/course.repository';

export interface ListMyCoursesInput {
  readonly ownerId: string;
  readonly status?: CourseStatus;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * `ListMyCourses` (design §5): the owner's non-deleted courses, most recently changed first
 * (keyset `(updated_at DESC, id DESC)` on the exact timestamp text), with the derived badge.
 */
@Injectable()
export class ListMyCoursesQuery {
  constructor(private readonly courses: CourseRepository) {}

  async execute(input: ListMyCoursesInput): Promise<MyCoursePage> {
    const after = input.cursor === undefined ? null : decodeMyCoursesCursor(input.cursor);
    const rows = await this.courses.listByOwner({
      ownerId: input.ownerId,
      status: input.status,
      after,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        badge: courseBadge(row, row.latestDecision),
        thumbnailAssetId: row.thumbnailAssetId,
        firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? encodeMyCoursesCursor({ updatedAt: last.updatedAtText, id: last.id })
          : null,
    };
  }
}
