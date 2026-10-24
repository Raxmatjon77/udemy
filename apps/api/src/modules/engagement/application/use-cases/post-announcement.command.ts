import { Injectable } from '@nestjs/common';
import { ANNOUNCEMENT_LIMITS, type Announcement, AnnouncementPosted } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { announcementQuota } from '../../domain/announcement';
import { AnnouncementLimitExceeded, CourseNotFound } from '../../domain/engagement.errors';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { toAnnouncement } from '../announcement-views';
import { PeopleDirectory } from '../people';
import { AnnouncementRepository } from '../ports/announcement.repository';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';

export interface PostAnnouncementInput {
  /** The course owner (`@CheckPolicy({ resource: 'course', action: 'engage' })`). */
  readonly actorId: string;
  readonly courseId: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly sendEmail: boolean;
}

/**
 * `PostAnnouncement` (design §5, D18, race R12): the course must be PUBLISHED or ARCHIVED.
 * Under the course's `anno` advisory lock the last 30 days are counted (deleted posts
 * included); at `ANNOUNCEMENT_LIMITS.perCourse` the post is refused with `retryAt` (when the
 * oldest counted post leaves the window). The insert and `AnnouncementPosted` (the worker's
 * fan-out job writes one notification per active learner, P5-T15) commit together.
 *
 * Errors: 404 `course_not_found`, 422 `announcement_limit_exceeded` / `markdown_not_allowed`,
 * 429 (20 per 24 h per instructor).
 */
@Injectable()
export class PostAnnouncementCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly catalog: CatalogFacade,
    private readonly announcements: AnnouncementRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
    private readonly people: PeopleDirectory,
  ) {}

  async execute(input: PostAnnouncementInput): Promise<Announcement> {
    await this.rateLimiter.hit('announcementPost', input.actorId);
    const course = await this.catalog.getPublishedCourse(input.courseId);
    if (course === null) throw new CourseNotFound();
    assertMarkdownAllowed('bodyMd', input.bodyMd);

    const announcement = await this.tx.run(async (trx) => {
      const used = await this.announcements.lockQuota(trx, course.id);
      if (used >= ANNOUNCEMENT_LIMITS.perCourse) {
        const quota = announcementQuota(await this.announcements.windowCreatedAts(course.id, trx));
        if (quota.nextAvailableAt === null) {
          throw new Error(`announcement quota of ${course.id}: ${used} counted, no window rows`);
        }
        throw new AnnouncementLimitExceeded(quota.nextAvailableAt);
      }
      const created = await this.announcements.insert(trx, {
        courseId: course.id,
        authorId: input.actorId,
        title: input.title,
        bodyMd: input.bodyMd,
        sendEmail: input.sendEmail,
      });
      await this.events.publish(trx, AnnouncementPosted, {
        announcementId: created.id,
        courseId: created.courseId,
        authorId: created.authorId,
        sendEmail: created.sendEmail,
        postedAt: created.createdAt.toISOString(),
      });
      return created;
    });
    return toAnnouncement(announcement, await this.people.lookup([announcement.authorId]));
  }
}
