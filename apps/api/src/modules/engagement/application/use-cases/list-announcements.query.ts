import { Injectable } from '@nestjs/common';
import type { AnnouncementPage } from '@udemy/contracts';
import type { AnnouncementRecord } from '../../domain/announcement';
import { toAnnouncement } from '../announcement-views';
import { decodeOptionalKeyset, toPage } from '../engagement-cursor';
import { PeopleDirectory } from '../people';
import { AnnouncementRepository } from '../ports/announcement.repository';
import type { CreatedAtRow } from '../ports/qa.repository';
import { QaAccess, type QaViewer } from '../qa-access';

export interface ListAnnouncementsInput {
  /** The learner (or the owner previewing the course in the student app). */
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** One announcements page with the authors' public profiles. */
export async function announcementPage(
  rows: readonly CreatedAtRow<AnnouncementRecord>[],
  limit: number,
  people: PeopleDirectory,
): Promise<AnnouncementPage> {
  const authors = await people.lookup(rows.slice(0, limit).map((r) => r.record.authorId));
  return toPage(
    rows,
    limit,
    (row) => ({ at: row.createdAtKey, id: row.record.id }),
    (shown) => shown.map((row) => toAnnouncement(row.record, authors)),
  );
}

/**
 * `ListAnnouncements` for learners (`GET /me/courses/:courseId/announcements`, design §5/§8):
 * an ACTIVE enrollment or the owner (the same rule as Q&A), the non-deleted announcements newest
 * first, keyset (created_at DESC, id DESC).
 *
 * Errors: 403 `enrollment_required`, 404 `course_not_found`, 422 invalid cursor.
 */
@Injectable()
export class ListAnnouncementsQuery {
  constructor(
    private readonly access: QaAccess,
    private readonly announcements: AnnouncementRepository,
    private readonly people: PeopleDirectory,
  ) {}

  async execute(input: ListAnnouncementsInput): Promise<AnnouncementPage> {
    const course = await this.access.require(input.courseId, input.viewer);
    const after = decodeOptionalKeyset(input.cursor);
    const rows = await this.announcements.listLive(
      course.courseId,
      after === null ? null : { createdAt: after.at, id: after.id },
      input.limit + 1,
    );
    return announcementPage(rows, input.limit, this.people);
  }
}
