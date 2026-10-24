import { randomUUID } from 'node:crypto';
import type {
  EventDefinition,
  EventPayloadInput,
  ModerationStatus,
  PublicProfile,
  ReportStatus,
  ReportSubjectType,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import { RateLimitedError } from '../../../../shared/errors';
import type { LectureCompletionCounter } from '../../../../shared/learning-progress';
import type {
  CatalogFacade,
  CourseSummary,
  LiveCurriculum,
  LiveLectureRef,
  PublishedCourseSummary,
} from '../../../catalog';
import type { EnrollmentFacade } from '../../../enrollment';
import type { UsersFacade } from '../../../users';
import type { ReportOutcome, ReportRecord } from '../../domain/report';
import type { CourseRatingStats, ReviewRecord, ReviewReplyRecord } from '../../domain/review';
import { EngagementSettings } from '../engagement-settings';
import { PeopleDirectory } from '../people';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import {
  EngagementRateLimiter,
  type EngagementRateLimitName,
} from '../ports/engagement-rate-limiter';
import { type FileReportInput, ReportRepository } from '../ports/report.repository';
import {
  type ReviewListFilter,
  type ReviewListRow,
  ReviewRepository,
  type SoftDeleted,
  type SoftDeletedReply,
  type UpsertReplyRecord,
  type UpsertReviewRecord,
} from '../ports/review.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import {
  type WishlistKeyset,
  WishlistRepository,
  type WishlistRow,
} from '../ports/wishlist.repository';
import { ReviewReplyReportSubject } from '../report-subjects/review-reply.report-subject';
import { ReviewReportSubject } from '../report-subjects/review.report-subject';
import { ReviewEligibility } from '../review-eligibility';
import { AddToWishlistCommand } from '../use-cases/add-to-wishlist.command';
import { DeleteMyReviewCommand } from '../use-cases/delete-my-review.command';
import { DeleteReviewReplyCommand } from '../use-cases/delete-review-reply.command';
import { GetMyCourseReviewQuery } from '../use-cases/get-my-course-review.query';
import { GetRatingsQuery } from '../use-cases/get-ratings.query';
import { GetWishlistStatesQuery } from '../use-cases/get-wishlist-states.query';
import { ListCourseReviewsQuery } from '../use-cases/list-course-reviews.query';
import { ListPublicReviewsQuery } from '../use-cases/list-public-reviews.query';
import { ListWishlistQuery } from '../use-cases/list-wishlist.query';
import { RemoveFromWishlistCommand } from '../use-cases/remove-from-wishlist.command';
import { ReportContentCommand } from '../use-cases/report-content.command';
import { UpsertMyReviewCommand } from '../use-cases/upsert-my-review.command';
import { UpsertReviewReplyCommand } from '../use-cases/upsert-review-reply.command';

/** Stands in for an open Kysely transaction (fakes never run SQL). */
export const FAKE_TRX = { isTransaction: true } as unknown as Transaction<DB>;

/** A strictly increasing clock: every write gets a distinct timestamp (keyset tests). */
export class Clock {
  private t = Date.UTC(2026, 9, 1, 12, 0, 0);
  next(): Date {
    this.t += 1000;
    return new Date(this.t);
  }
  /** The current time, without advancing. */
  now(): Date {
    return new Date(this.t);
  }
  /** Jumps forward (quota windows). */
  advance(ms: number): void {
    this.t += ms;
  }
}

/** What SQL would print for `created_at` (microseconds). */
export function exactText(date: Date): string {
  return date.toISOString().replace('Z', '000Z');
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface StoredReview extends Mutable<Omit<ReviewRecord, 'reply'>> {
  deletedAt: Date | null;
}

interface StoredReply extends Mutable<ReviewReplyRecord> {
  deletedAt: Date | null;
}

const byNewest = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

/** In-memory twin of the review/reply SQL (live uniques, soft deletes, the upsert outcomes). */
export class InMemoryReviewRepository extends ReviewRepository {
  readonly reviews: StoredReview[] = [];
  readonly replies: StoredReply[] = [];
  readonly stats = new Map<string, CourseRatingStats>();
  readonly locked: string[] = [];

  constructor(private readonly clock: Clock) {
    super();
  }

  private record(r: StoredReview): ReviewRecord {
    const reply = this.replies.find((x) => x.reviewId === r.id && x.deletedAt === null) ?? null;
    return {
      id: r.id,
      courseId: r.courseId,
      userId: r.userId,
      rating: r.rating,
      body: r.body,
      moderationStatus: r.moderationStatus,
      suspendedAt: r.suspendedAt,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      reply:
        reply === null
          ? null
          : {
              id: reply.id,
              reviewId: reply.reviewId,
              authorId: reply.authorId,
              body: reply.body,
              moderationStatus: reply.moderationStatus,
              createdAt: reply.createdAt,
              editedAt: reply.editedAt,
            },
    };
  }

  private live(): StoredReview[] {
    return this.reviews.filter((r) => r.deletedAt === null);
  }

  /** Test helper: a review by anyone (bypasses eligibility). */
  seed(input: {
    courseId: string;
    userId: string;
    rating?: number;
    body?: string | null;
    moderationStatus?: ModerationStatus;
    suspended?: boolean;
  }): string {
    const at = this.clock.next();
    const review: StoredReview = {
      id: randomUUID(),
      courseId: input.courseId,
      userId: input.userId,
      rating: input.rating ?? 5,
      body: input.body ?? null,
      moderationStatus: input.moderationStatus ?? 'VISIBLE',
      suspendedAt: input.suspended === true ? at : null,
      createdAt: at,
      editedAt: null,
      deletedAt: null,
    };
    this.reviews.push(review);
    return review.id;
  }

  /** Test helper: a live reply. */
  seedReply(
    reviewId: string,
    authorId: string,
    moderationStatus: ModerationStatus = 'VISIBLE',
  ): string {
    const reply: StoredReply = {
      id: randomUUID(),
      reviewId,
      authorId,
      body: 'Thanks!',
      moderationStatus,
      createdAt: this.clock.next(),
      editedAt: null,
      deletedAt: null,
    };
    this.replies.push(reply);
    return reply.id;
  }

  stored(reviewId: string): StoredReview {
    const review = this.reviews.find((r) => r.id === reviewId);
    if (review === undefined) throw new Error(`no review ${reviewId}`);
    return review;
  }

  getRatings(courseIds: readonly string[]): Promise<CourseRatingStats[]> {
    return Promise.resolve(courseIds.flatMap((id) => this.stats.get(id) ?? []));
  }

  private list(filter: ReviewListFilter, publishedOnly: boolean): Promise<ReviewListRow[]> {
    const rows = this.live()
      .filter(
        (r) =>
          r.courseId === filter.courseId &&
          (!publishedOnly || (r.moderationStatus === 'VISIBLE' && r.suspendedAt === null)) &&
          (filter.rating === undefined || r.rating === filter.rating),
      )
      .sort(byNewest)
      .filter(
        (r) =>
          filter.after === null ||
          exactText(r.createdAt) < filter.after.createdAt ||
          (exactText(r.createdAt) === filter.after.createdAt && r.id < filter.after.id),
      )
      .slice(0, filter.limit)
      .map((r) => ({ review: this.record(r), createdAtKey: exactText(r.createdAt) }));
    return Promise.resolve(rows);
  }

  listPublished(filter: ReviewListFilter): Promise<ReviewListRow[]> {
    return this.list(filter, true);
  }

  listLive(filter: ReviewListFilter): Promise<ReviewListRow[]> {
    return this.list(filter, false);
  }

  findLiveByUser(courseId: string, userId: string): Promise<ReviewRecord | null> {
    const r = this.live().find((x) => x.courseId === courseId && x.userId === userId);
    return Promise.resolve(r === undefined ? null : this.record(r));
  }

  findLiveById(reviewId: string, _ex?: Executor): Promise<ReviewRecord | null> {
    const r = this.live().find((x) => x.id === reviewId);
    return Promise.resolve(r === undefined ? null : this.record(r));
  }

  upsert(
    trx: Transaction<DB>,
    input: { courseId: string; userId: string; rating: number; body: string | null },
  ): Promise<UpsertReviewRecord> {
    if (!trx.isTransaction) throw new TypeError('upsert needs a transaction');
    const existing = this.live().find(
      (r) => r.courseId === input.courseId && r.userId === input.userId,
    );
    if (existing === undefined) {
      const id = this.seed({ ...input });
      return Promise.resolve({
        outcome: 'POSTED',
        previousRating: null,
        review: this.record(this.stored(id)),
      });
    }
    if (existing.rating === input.rating && existing.body === input.body) {
      return Promise.resolve({
        outcome: 'UNCHANGED',
        previousRating: null,
        review: this.record(existing),
      });
    }
    const previousRating = existing.rating;
    existing.rating = input.rating;
    existing.body = input.body;
    existing.editedAt = this.clock.next();
    return Promise.resolve({ outcome: 'EDITED', previousRating, review: this.record(existing) });
  }

  softDeleteByUser(
    trx: Transaction<DB>,
    courseId: string,
    userId: string,
  ): Promise<SoftDeleted | null> {
    if (!trx.isTransaction) throw new TypeError('softDeleteByUser needs a transaction');
    const r = this.live().find((x) => x.courseId === courseId && x.userId === userId);
    if (r === undefined) return Promise.resolve(null);
    r.deletedAt = this.clock.next();
    return Promise.resolve({ id: r.id, deletedAt: r.deletedAt });
  }

  lockLiveInCourse(
    trx: Transaction<DB>,
    courseId: string,
    reviewId: string,
  ): Promise<ReviewRecord | null> {
    if (!trx.isTransaction) throw new TypeError('lockLiveInCourse needs a transaction');
    this.locked.push(reviewId);
    const r = this.live().find((x) => x.id === reviewId && x.courseId === courseId);
    return Promise.resolve(r === undefined ? null : this.record(r));
  }

  upsertReply(
    trx: Transaction<DB>,
    input: { reviewId: string; authorId: string; body: string },
  ): Promise<UpsertReplyRecord> {
    if (!trx.isTransaction) throw new TypeError('upsertReply needs a transaction');
    const existing = this.replies.find(
      (x) => x.reviewId === input.reviewId && x.deletedAt === null,
    );
    let outcome: UpsertReplyRecord['outcome'];
    if (existing === undefined) {
      this.seedReply(input.reviewId, input.authorId);
      const created = this.replies[this.replies.length - 1];
      if (created !== undefined) created.body = input.body;
      outcome = 'POSTED';
    } else if (existing.body === input.body) {
      outcome = 'UNCHANGED';
    } else {
      existing.body = input.body;
      existing.editedAt = this.clock.next();
      outcome = 'EDITED';
    }
    return Promise.resolve({ outcome, review: this.record(this.stored(input.reviewId)) });
  }

  softDeleteReply(trx: Transaction<DB>, reviewId: string): Promise<SoftDeletedReply | null> {
    if (!trx.isTransaction) throw new TypeError('softDeleteReply needs a transaction');
    const reply = this.replies.find((x) => x.reviewId === reviewId && x.deletedAt === null);
    if (reply === undefined) return Promise.resolve(null);
    reply.deletedAt = this.clock.next();
    return Promise.resolve({ id: reply.id, authorId: reply.authorId, deletedAt: reply.deletedAt });
  }
}

interface StoredReport extends Mutable<ReportRecord> {
  subjectType: ReportSubjectType;
  subjectId: string;
  reporterId: string;
}

/** In-memory twin of `@udemy/db` `reportContent` (insert-or-keep, count, auto-hide). */
/** Resolves a reportable subject row of another fake store (Q&A): its status and a hide. */
export type FakeSubjectLookup = (
  type: ReportSubjectType,
  id: string,
) => { status: ModerationStatus; hide(): void } | null;

export class InMemoryReportRepository extends ReportRepository {
  readonly reports: StoredReport[] = [];
  readonly hidden: { subjectType: ReportSubjectType; subjectId: string }[] = [];
  /** Extra subject stores (the Q&A fake registers QUESTION / ANSWER here). */
  readonly subjectLookups: FakeSubjectLookup[] = [];

  constructor(
    private readonly reviews: InMemoryReviewRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  private subjectStatus(
    type: ReportSubjectType,
    id: string,
  ): { status: ModerationStatus; hide(): void } | null {
    if (type === 'REVIEW') {
      const r = this.reviews.reviews.find((x) => x.id === id && x.deletedAt === null);
      return r === undefined
        ? null
        : { status: r.moderationStatus, hide: () => (r.moderationStatus = 'HIDDEN') };
    }
    if (type === 'REVIEW_REPLY') {
      const r = this.reviews.replies.find((x) => x.id === id && x.deletedAt === null);
      return r === undefined
        ? null
        : { status: r.moderationStatus, hide: () => (r.moderationStatus = 'HIDDEN') };
    }
    for (const lookup of this.subjectLookups) {
      const found = lookup(type, id);
      if (found !== null) return found;
    }
    return null;
  }

  file(trx: Transaction<DB>, input: FileReportInput): Promise<ReportOutcome> {
    if (!trx.isTransaction) throw new TypeError('file needs a transaction');
    const subject = this.subjectStatus(input.subjectType, input.subjectId);
    if (subject === null) return Promise.resolve({ outcome: 'NOT_FOUND' });
    const same = (r: StoredReport): boolean =>
      r.subjectType === input.subjectType && r.subjectId === input.subjectId;
    const existing = this.reports.find((r) => same(r) && r.reporterId === input.reporterId);
    if (existing === undefined) {
      this.reports.push({
        id: randomUUID(),
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reporterId: input.reporterId,
        reason: input.reason,
        comment: input.comment,
        status: 'OPEN',
        createdAt: this.clock.next(),
        resolvedAt: null,
      });
    }
    const open = this.reports.filter((r) => same(r) && r.status === 'OPEN');
    let autoHidden = false;
    if (
      existing === undefined &&
      subject.status === 'VISIBLE' &&
      open.length >= input.autoHideThreshold
    ) {
      subject.hide();
      const at = this.clock.next();
      for (const r of open) {
        r.status = 'ACTIONED' satisfies ReportStatus;
        r.resolvedAt = at;
      }
      this.hidden.push({ subjectType: input.subjectType, subjectId: input.subjectId });
      autoHidden = true;
    }
    return Promise.resolve({
      outcome: existing === undefined ? 'REPORTED' : 'ALREADY_REPORTED',
      openReports: open.length,
      autoHidden,
    });
  }

  findByReporter(
    subjectType: ReportSubjectType,
    subjectId: string,
    reporterId: string,
  ): Promise<ReportRecord | null> {
    const r = this.reports.find(
      (x) =>
        x.subjectType === subjectType && x.subjectId === subjectId && x.reporterId === reporterId,
    );
    return Promise.resolve(r ?? null);
  }
}

/** In-memory wishlist with the cap count and the lock calls recorded. */
export class InMemoryWishlistRepository extends WishlistRepository {
  readonly items: { userId: string; courseId: string; addedAt: Date }[] = [];
  readonly lockedUsers: string[] = [];

  constructor(private readonly clock: Clock) {
    super();
  }

  contains(userId: string, courseId: string): Promise<boolean> {
    return Promise.resolve(this.items.some((i) => i.userId === userId && i.courseId === courseId));
  }

  lockCap(trx: Transaction<DB>, userId: string): Promise<number> {
    if (!trx.isTransaction) throw new TypeError('lockCap needs a transaction');
    this.lockedUsers.push(userId);
    return Promise.resolve(this.items.filter((i) => i.userId === userId).length);
  }

  async add(trx: Transaction<DB>, userId: string, courseId: string): Promise<boolean> {
    if (!trx.isTransaction) throw new TypeError('add needs a transaction');
    if (await this.contains(userId, courseId)) return false;
    this.items.push({ userId, courseId, addedAt: this.clock.next() });
    return true;
  }

  remove(userId: string, courseId: string): Promise<boolean> {
    const index = this.items.findIndex((i) => i.userId === userId && i.courseId === courseId);
    if (index >= 0) this.items.splice(index, 1);
    return Promise.resolve(index >= 0);
  }

  listPage(userId: string, after: WishlistKeyset | null, limit: number): Promise<WishlistRow[]> {
    const rows = this.items
      .filter((i) => i.userId === userId)
      .map((i) => ({ courseId: i.courseId, addedAt: i.addedAt, addedAtKey: exactText(i.addedAt) }))
      .sort(
        (a, b) => b.addedAt.getTime() - a.addedAt.getTime() || (a.courseId < b.courseId ? 1 : -1),
      )
      .filter(
        (r) =>
          after === null ||
          r.addedAtKey < after.addedAt ||
          (r.addedAtKey === after.addedAt && r.courseId < after.courseId),
      );
    return Promise.resolve(rows.slice(0, limit));
  }

  wishlistedAmong(userId: string, courseIds: readonly string[]): Promise<ReadonlySet<string>> {
    return Promise.resolve(
      new Set(
        this.items
          .filter((i) => i.userId === userId && courseIds.includes(i.courseId))
          .map((i) => i.courseId),
      ),
    );
  }
}

/** Records events; the transaction runner discards the ones of a rolled-back transaction. */
export class RecordingEventPublisher extends EngagementEventPublisher {
  readonly events: { type: string; aggregateId: string; payload: unknown }[] = [];

  publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly courseId: string },
  ): Promise<void> {
    if (!trx.isTransaction) throw new TypeError('publish needs a transaction');
    // The real publisher validates the payload against the contract.
    this.events.push({
      type: event.type,
      aggregateId: payload.courseId,
      payload: event.parsePayload(payload),
    });
    return Promise.resolve();
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

export class FakeTransactionRunner extends TransactionRunner {
  runs = 0;

  constructor(private readonly events: RecordingEventPublisher) {
    super();
  }

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    this.runs += 1;
    const before = this.events.events.length;
    try {
      return await work(FAKE_TRX);
    } catch (error) {
      this.events.events.splice(before);
      throw error;
    }
  }
}

export class FakeRateLimiter extends EngagementRateLimiter {
  readonly hits: { rule: EngagementRateLimitName; subject: string }[] = [];
  readonly limited = new Set<EngagementRateLimitName>();

  hit(rule: EngagementRateLimitName, subject: string): Promise<void> {
    this.hits.push({ rule, subject });
    if (this.limited.has(rule)) {
      return Promise.reject(new RateLimitedError('Too many requests.', { retryAfterMs: 1000 }));
    }
    return Promise.resolve();
  }
}

/** Courses with a live revision (catalog's `getPublishedCourse` / `getCourseSummaries`). */
export class FakeCatalog {
  readonly courses = new Map<string, CourseSummary>();
  /** Live lectures per course: id -> title. */
  readonly lectures = new Map<string, Map<string, string>>();

  addLecture(courseId: string, title = 'Lecture'): string {
    const id = randomUUID();
    const lectures = this.lectures.get(courseId) ?? new Map<string, string>();
    lectures.set(id, title);
    this.lectures.set(courseId, lectures);
    return id;
  }

  getLiveLecture(courseId: string, lectureId: string): Promise<LiveLectureRef | null> {
    const c = this.courses.get(courseId);
    if (c === undefined || this.lectures.get(courseId)?.has(lectureId) !== true) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      courseId,
      ownerId: c.ownerId,
      status: c.status,
      liveRevisionId: c.liveRevisionId,
      lectureId,
      type: 'ARTICLE',
      durationSeconds: null,
      mediaAssetId: null,
    });
  }

  getLiveCurriculum(courseId: string): Promise<LiveCurriculum | null> {
    const c = this.courses.get(courseId);
    if (c === undefined) return Promise.resolve(null);
    const lectures = [...(this.lectures.get(courseId) ?? new Map<string, string>())];
    return Promise.resolve({
      courseId,
      ownerId: c.ownerId,
      status: c.status,
      liveRevisionId: c.liveRevisionId,
      slug: c.slug,
      title: c.title,
      sections: [
        {
          id: randomUUID(),
          title: 'Section',
          lectures: lectures.map(([id, title]) => ({
            id,
            type: 'ARTICLE' as const,
            title,
            durationSeconds: null,
            isPreview: false,
            mediaAssetId: null,
            quiz: null,
          })),
        },
      ],
    });
  }

  getOwnedLiveCourseIds(ownerId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.courses.values()].filter((c) => c.ownerId === ownerId).map((c) => c.id),
    );
  }

  add(ownerId: string, status: 'PUBLISHED' | 'ARCHIVED' = 'PUBLISHED'): CourseSummary {
    const id = randomUUID();
    const course: CourseSummary = {
      id,
      slug: `course-${id.slice(0, 8)}`,
      ownerId,
      status,
      liveRevisionId: randomUUID(),
      title: `Course ${id.slice(0, 8)}`,
      hasThumbnail: true,
    };
    this.courses.set(id, course);
    return course;
  }

  getPublishedCourse(courseId: string): Promise<PublishedCourseSummary | null> {
    const c = this.courses.get(courseId);
    return Promise.resolve(
      c === undefined
        ? null
        : {
            id: c.id,
            slug: c.slug,
            ownerId: c.ownerId,
            status: c.status,
            liveRevisionId: c.liveRevisionId,
            firstPublishedAt: new Date(0),
          },
    );
  }

  getCourseSummaries(courseIds: readonly string[]): Promise<CourseSummary[]> {
    return Promise.resolve(courseIds.flatMap((id) => this.courses.get(id) ?? []));
  }
}

export class FakeEnrollment {
  readonly active = new Set<string>();

  enroll(userId: string, courseId: string): void {
    this.active.add(`${userId}:${courseId}`);
  }

  hasAccess(userId: string, courseId: string): Promise<boolean> {
    return Promise.resolve(this.active.has(`${userId}:${courseId}`));
  }
}

export class FakeCompletions implements LectureCompletionCounter {
  readonly counts = new Map<string, number>();
  readonly calls: string[] = [];

  set(userId: string, courseId: string, count: number): void {
    this.counts.set(`${userId}:${courseId}`, count);
  }

  completedLectureCount(userId: string, courseId: string): Promise<number> {
    this.calls.push(`${userId}:${courseId}`);
    return Promise.resolve(this.counts.get(`${userId}:${courseId}`) ?? 0);
  }
}

/** Public profiles; banned users are simply absent. */
export class FakeUsers {
  readonly profiles = new Map<string, PublicProfile>();

  add(displayName: string): string {
    const id = randomUUID();
    this.profiles.set(id, {
      id,
      displayName,
      headline: null,
      bio: null,
      avatarUrl: null,
      isInstructor: false,
    });
    return id;
  }

  getPublicProfiles(userIds: readonly string[]): Promise<PublicProfile[]> {
    return Promise.resolve(userIds.flatMap((id) => this.profiles.get(id) ?? []));
  }
}

/** The application layer wired against the fakes, exactly as the module wires it. */
export function createEngagementHarness(options: { autoHideReports?: number } = {}) {
  const clock = new Clock();
  const reviews = new InMemoryReviewRepository(clock);
  const reports = new InMemoryReportRepository(reviews, clock);
  const wishlist = new InMemoryWishlistRepository(clock);
  const events = new RecordingEventPublisher();
  const tx = new FakeTransactionRunner(events);
  const rateLimiter = new FakeRateLimiter();
  const catalogFake = new FakeCatalog();
  const enrollmentFake = new FakeEnrollment();
  const completions = new FakeCompletions();
  const usersFake = new FakeUsers();
  const settings = new EngagementSettings(options.autoHideReports ?? 3);

  const catalog = catalogFake as unknown as CatalogFacade;
  const enrollment = enrollmentFake as unknown as EnrollmentFacade;
  const people = new PeopleDirectory(usersFake as unknown as UsersFacade);
  const eligibility = new ReviewEligibility(enrollment, completions);
  const handlers = [
    new ReviewReportSubject(reviews, events),
    new ReviewReplyReportSubject(reviews, events),
  ];

  return {
    clock,
    reviews,
    reports,
    wishlist,
    events,
    tx,
    rateLimiter,
    catalog: catalogFake,
    enrollment: enrollmentFake,
    completions,
    users: usersFake,
    getRatings: new GetRatingsQuery(rateLimiter, reviews),
    listPublicReviews: new ListPublicReviewsQuery(rateLimiter, catalog, reviews, people),
    getMyReview: new GetMyCourseReviewQuery(catalog, reviews, eligibility, people),
    upsertMyReview: new UpsertMyReviewCommand(
      rateLimiter,
      catalog,
      eligibility,
      reviews,
      events,
      people,
      tx,
    ),
    deleteMyReview: new DeleteMyReviewCommand(reviews, events, tx),
    listCourseReviews: new ListCourseReviewsQuery(reviews, people),
    upsertReply: new UpsertReviewReplyCommand(rateLimiter, reviews, events, people, tx),
    deleteReply: new DeleteReviewReplyCommand(reviews, events, tx),
    reportContent: new ReportContentCommand(rateLimiter, reports, settings, tx, handlers),
    listWishlist: new ListWishlistQuery(wishlist, catalog, people),
    wishlistStates: new GetWishlistStatesQuery(wishlist),
    addToWishlist: new AddToWishlistCommand(rateLimiter, catalog, enrollment, wishlist, tx),
    removeFromWishlist: new RemoveFromWishlistCommand(rateLimiter, wishlist),
  };
}

export type EngagementHarness = ReturnType<typeof createEngagementHarness>;
