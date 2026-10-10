import { Injectable } from '@nestjs/common';
import type { ReviewQueuePage } from '@udemy/contracts';
import { decodeReviewQueueCursor, encodeReviewQueueCursor } from '../course-cursor';
import { CoursePeopleDirectory } from '../ports/course-people.directory';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { UNKNOWN_PERSON } from './get-course-history.query';

export interface ListReviewQueueInput {
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * `ListReviewQueue` (admin, design §5): pending revisions oldest first, keyset on the uuidv7
 * revision id (schema doc §6 item 16), with the owner's display name.
 */
@Injectable()
export class ListReviewQueueQuery {
  constructor(
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly people: CoursePeopleDirectory,
  ) {}

  async execute(input: ListReviewQueueInput): Promise<ReviewQueuePage> {
    const after = input.cursor === undefined ? null : decodeReviewQueueCursor(input.cursor);
    const rows = await this.lifecycle.listReviewQueue({
      limit: input.limit + 1,
      afterRevisionId: after,
    });
    const page = rows.slice(0, input.limit);
    const people = await this.people.findPeople(page.map((r) => r.ownerId));
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        courseId: r.courseId,
        revisionId: r.revisionId,
        revisionNo: r.revisionNo,
        kind: r.kind,
        title: r.title,
        owner: { id: r.ownerId, displayName: people.get(r.ownerId)?.displayName ?? UNKNOWN_PERSON },
        submittedAt: r.submittedAt.toISOString(),
      })),
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? encodeReviewQueueCursor(last.revisionId)
          : null,
    };
  }
}
