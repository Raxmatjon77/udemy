import { Injectable } from '@nestjs/common';
import type { InstructorAnnouncementPage } from '@udemy/contracts';
import { announcementQuota } from '../../domain/announcement';
import { toAnnouncementQuota } from '../announcement-views';
import { decodeOptionalKeyset } from '../engagement-cursor';
import { PeopleDirectory } from '../people';
import { AnnouncementRepository } from '../ports/announcement.repository';
import { announcementPage } from './list-announcements.query';

export interface ListCourseAnnouncementsInput {
  /** Already authorised by `@CheckPolicy({ resource: 'course', action: 'engage' })`. */
  readonly courseId: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * The owner's announcements page (`GET /courses/:courseId/announcements`, design §8
 * "Instructor") plus the posting quota (used in the last 30 days, deleted posts included, and
 * when the next post is allowed once it is used up).
 */
@Injectable()
export class ListCourseAnnouncementsQuery {
  constructor(
    private readonly announcements: AnnouncementRepository,
    private readonly people: PeopleDirectory,
  ) {}

  async execute(input: ListCourseAnnouncementsInput): Promise<InstructorAnnouncementPage> {
    const after = decodeOptionalKeyset(input.cursor);
    const [rows, window] = await Promise.all([
      this.announcements.listLive(
        input.courseId,
        after === null ? null : { createdAt: after.at, id: after.id },
        input.limit + 1,
      ),
      this.announcements.windowCreatedAts(input.courseId),
    ]);
    const page = await announcementPage(rows, input.limit, this.people);
    return { ...page, quota: toAnnouncementQuota(announcementQuota(window)) };
  }
}
