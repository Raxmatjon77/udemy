import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  InstructorReviewPageSchema,
  MyCourseReviewSchema,
  MyReviewSchema,
  PublicReviewPageSchema,
  RatingsResponseSchema,
  ReportSchema,
  ReviewReplySchema,
  WishlistPageSchema,
  WISHLIST_LIMITS,
} from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors';
import {
  CannotReportOwnContent,
  CannotReviewOwnCourse,
  CourseNotFound,
  CourseNotWishlistable,
  EnrollmentRequired,
  ReplyNotFound,
  ReviewNotEligible,
  ReviewNotFound,
  WishlistFull,
} from '../../domain/engagement.errors';
import { decodeKeyset } from '../engagement-cursor';
import { createEngagementHarness, type EngagementHarness } from '../testing/engagement.fakes';

/** An owner, a published course, and an enrolled student with one completed lecture. */
function setup(h: EngagementHarness = createEngagementHarness()) {
  const owner = h.users.add('Owner');
  const student = h.users.add('Student');
  const course = h.catalog.add(owner);
  h.enrollment.enroll(student, course.id);
  h.completions.set(student, course.id, 1);
  return { h, owner, student, course };
}

describe('UpsertMyReview (D10, R4)', () => {
  it('posts (201, ReviewPosted keyed by courseId), edits (200, ReviewEdited), no-ops when unchanged', async () => {
    const { h, student, course } = setup();

    const posted = await h.upsertMyReview.execute({
      userId: student,
      courseId: course.id,
      rating: 4,
      body: 'Great',
    });
    const edited = await h.upsertMyReview.execute({
      userId: student,
      courseId: course.id,
      rating: 2,
      body: 'Great',
    });
    const unchanged = await h.upsertMyReview.execute({
      userId: student,
      courseId: course.id,
      rating: 2,
      body: 'Great',
    });

    expect(posted.created).toBe(true);
    expect(MyReviewSchema.parse(posted.review)).toMatchObject({
      courseId: course.id,
      rating: 4,
      body: 'Great',
      state: 'PUBLISHED',
      editedAt: null,
      reply: null,
    });
    expect(edited.created).toBe(false);
    expect(edited.review).toMatchObject({ id: posted.review.id, rating: 2 });
    expect(edited.review.editedAt).not.toBeNull();
    expect(unchanged).toEqual({ review: edited.review, created: false });

    expect(h.events.types()).toEqual(['ReviewPosted', 'ReviewEdited']);
    expect(h.events.events.every((e) => e.aggregateId === course.id)).toBe(true);
    expect(h.events.events[0]?.payload).toMatchObject({
      reviewId: posted.review.id,
      userId: student,
      rating: 4,
      previousRating: null,
    });
    expect(h.events.events[1]?.payload).toMatchObject({ rating: 2, previousRating: 4 });
    expect(h.rateLimiter.hits.map((x) => x.rule)).toEqual([
      'reviewWrite',
      'reviewWrite',
      'reviewWrite',
    ]);
  });

  it('refuses the owner (403), a non-enrolled user (403), no completed lecture (422)', async () => {
    const { h, owner, course } = setup();
    const outsider = h.users.add('Outsider');
    const fresh = h.users.add('Fresh');
    h.enrollment.enroll(fresh, course.id);
    const write = (userId: string) =>
      h.upsertMyReview.execute({ userId, courseId: course.id, rating: 5, body: null });

    await expect(write(owner)).rejects.toBeInstanceOf(CannotReviewOwnCourse);
    await expect(write(outsider)).rejects.toBeInstanceOf(EnrollmentRequired);
    await expect(write(fresh)).rejects.toBeInstanceOf(ReviewNotEligible);
    expect(h.events.events).toHaveLength(0);
    expect(h.tx.runs).toBe(0);
    // the progress port is only asked once the cheaper checks passed
    expect(h.completions.calls).toEqual([`${fresh}:${course.id}`]);
  });

  it('404 course_not_found for a course without a live revision; 429 before anything else', async () => {
    const { h, student } = setup();
    await expect(
      h.upsertMyReview.execute({ userId: student, courseId: randomUUID(), rating: 5, body: null }),
    ).rejects.toBeInstanceOf(CourseNotFound);

    h.rateLimiter.limited.add('reviewWrite');
    await expect(
      h.upsertMyReview.execute({ userId: student, courseId: randomUUID(), rating: 5, body: null }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('works for an archived course (still live for its enrolled students)', async () => {
    const h = createEngagementHarness();
    const owner = h.users.add('Owner');
    const student = h.users.add('Student');
    const course = h.catalog.add(owner, 'ARCHIVED');
    h.enrollment.enroll(student, course.id);
    h.completions.set(student, course.id, 3);
    const result = await h.upsertMyReview.execute({
      userId: student,
      courseId: course.id,
      rating: 3,
      body: null,
    });
    expect(result.created).toBe(true);
  });
});

describe('GetMyCourseReview', () => {
  it('reports eligibility and the own review in any state', async () => {
    const { h, owner, student, course } = setup();
    const before = await h.getMyReview.execute({ userId: student, courseId: course.id });
    expect(MyCourseReviewSchema.parse(before)).toEqual({
      courseId: course.id,
      review: null,
      canReview: true,
      blockReason: null,
    });

    const id = h.reviews.seed({ courseId: course.id, userId: student, moderationStatus: 'HIDDEN' });
    h.reviews.seedReply(id, owner, 'HIDDEN');
    const mine = await h.getMyReview.execute({ userId: student, courseId: course.id });
    expect(mine.review).toMatchObject({ id, state: 'HIDDEN', reply: null });

    const ownerView = await h.getMyReview.execute({ userId: owner, courseId: course.id });
    expect(MyCourseReviewSchema.parse(ownerView)).toMatchObject({
      canReview: false,
      blockReason: ErrorCode.CannotReviewOwnCourse,
    });
  });
});

describe('DeleteMyReview', () => {
  it('soft-deletes with ReviewDeleted (actor = author); then 404, and a new review may follow', async () => {
    const { h, student, course } = setup();
    const first = await h.upsertMyReview.execute({
      userId: student,
      courseId: course.id,
      rating: 1,
      body: null,
    });

    await h.deleteMyReview.execute({ userId: student, courseId: course.id });
    await expect(
      h.deleteMyReview.execute({ userId: student, courseId: course.id }),
    ).rejects.toBeInstanceOf(ReviewNotFound);
    const second = await h.upsertMyReview.execute({
      userId: student,
      courseId: course.id,
      rating: 5,
      body: null,
    });

    expect(second.created).toBe(true);
    expect(second.review.id).not.toBe(first.review.id);
    expect(h.events.types()).toEqual(['ReviewPosted', 'ReviewDeleted', 'ReviewPosted']);
    expect(h.events.events[1]?.payload).toMatchObject({
      reviewId: first.review.id,
      courseId: course.id,
      actorId: student,
    });
  });

  it("never touches another user's review (IDOR: scoped to the principal)", async () => {
    const { h, student, course } = setup();
    const other = h.users.add('Other');
    h.reviews.seed({ courseId: course.id, userId: other });
    await expect(
      h.deleteMyReview.execute({ userId: student, courseId: course.id }),
    ).rejects.toBeInstanceOf(ReviewNotFound);
    expect(h.reviews.reviews.every((r) => r.deletedAt === null)).toBe(true);
  });
});

describe('ListPublicReviews / ListCourseReviews', () => {
  it('public: PUBLISHED only, newest first, keyset pages, banned authors are null, hidden replies omitted', async () => {
    const { h, owner, course } = setup();
    const a = h.reviews.seed({ courseId: course.id, userId: h.users.add('A'), rating: 5 });
    const banned = randomUUID(); // no public profile
    const b = h.reviews.seed({ courseId: course.id, userId: banned, rating: 4 });
    h.reviews.seed({ courseId: course.id, userId: h.users.add('C'), moderationStatus: 'HIDDEN' });
    h.reviews.seed({ courseId: course.id, userId: h.users.add('D'), suspended: true });
    const c = h.reviews.seed({ courseId: course.id, userId: h.users.add('E'), rating: 5 });
    h.reviews.seedReply(c, owner, 'HIDDEN');
    h.reviews.seedReply(a, owner);

    const page1 = await h.listPublicReviews.execute({
      courseId: course.id,
      limit: 2,
      ip: '203.0.113.9',
    });
    expect(PublicReviewPageSchema.parse(page1).items.map((r) => r.id)).toEqual([c, b]);
    expect(page1.items[0]?.reply).toBeNull();
    expect(page1.items[1]?.author).toBeNull();
    expect(page1.nextCursor).not.toBeNull();
    expect(decodeKeyset(page1.nextCursor ?? '').id).toBe(b);

    const page2 = await h.listPublicReviews.execute({
      courseId: course.id,
      cursor: page1.nextCursor ?? undefined,
      limit: 2,
      ip: '203.0.113.9',
    });
    expect(page2.items.map((r) => r.id)).toEqual([a]);
    expect(page2.items[0]?.reply).toMatchObject({ author: { id: owner, displayName: 'Owner' } });
    expect(page2.nextCursor).toBeNull();

    const fives = await h.listPublicReviews.execute({
      courseId: course.id,
      rating: 5,
      limit: 10,
      ip: '203.0.113.9',
    });
    expect(fives.items.map((r) => r.id)).toEqual([c, a]);
    expect(
      h.rateLimiter.hits.every((x) => x.rule === 'publicRead' && x.subject === '203.0.113.9'),
    ).toBe(true);

    await expect(
      h.listPublicReviews.execute({ courseId: randomUUID(), limit: 10, ip: '203.0.113.9' }),
    ).rejects.toBeInstanceOf(CourseNotFound);
  });

  it('instructor: every live review with its state and reply (hidden flagged)', async () => {
    const { h, owner, course } = setup();
    const hidden = h.reviews.seed({
      courseId: course.id,
      userId: h.users.add('A'),
      moderationStatus: 'HIDDEN',
    });
    h.reviews.seedReply(hidden, owner, 'HIDDEN');
    const suspended = h.reviews.seed({
      courseId: course.id,
      userId: h.users.add('B'),
      suspended: true,
    });
    const otherCourse = h.catalog.add(owner);
    h.reviews.seed({ courseId: otherCourse.id, userId: h.users.add('C') });

    const page = await h.listCourseReviews.execute({ courseId: course.id, limit: 10 });
    expect(InstructorReviewPageSchema.parse(page).items.map((r) => [r.id, r.state])).toEqual([
      [suspended, 'SUSPENDED'],
      [hidden, 'HIDDEN'],
    ]);
    expect(page.items[1]?.reply).toMatchObject({ reviewId: hidden, hidden: true });
  });
});

describe('GetRatings', () => {
  it('one item per requested id, in order; missing rows are {count: 0}', async () => {
    const { h, course } = setup();
    const other = randomUUID();
    h.reviews.stats.set(course.id, {
      courseId: course.id,
      reviewCount: 2,
      average: '4.5',
      counts: [0, 0, 0, 1, 1],
    });
    const res = await h.getRatings.execute({ courseIds: [other, course.id], ip: '198.51.100.1' });
    expect(RatingsResponseSchema.parse(res).items).toEqual([
      {
        courseId: other,
        average: null,
        count: 0,
        histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      },
      {
        courseId: course.id,
        average: '4.5',
        count: 2,
        histogram: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 1 },
      },
    ]);
    expect(h.rateLimiter.hits).toEqual([{ rule: 'publicRead', subject: '198.51.100.1' }]);
  });
});

describe('UpsertReviewReply / DeleteReviewReply (D10)', () => {
  it('posts, edits, no-ops; events keyed by courseId; the review row is locked', async () => {
    const { h, owner, student, course } = setup();
    const reviewId = h.reviews.seed({ courseId: course.id, userId: student });
    const input = { actorId: owner, courseId: course.id, reviewId, body: 'Thank you' };

    const posted = await h.upsertReply.execute(input);
    const edited = await h.upsertReply.execute({ ...input, body: 'Thank you!' });
    const same = await h.upsertReply.execute({ ...input, body: 'Thank you!' });

    expect(ReviewReplySchema.parse(posted)).toMatchObject({
      reviewId,
      body: 'Thank you',
      hidden: false,
      author: { id: owner },
      editedAt: null,
    });
    expect(edited.editedAt).not.toBeNull();
    expect(same).toEqual(edited);
    expect(h.events.types()).toEqual(['ReviewReplyPosted', 'ReviewReplyEdited']);
    expect(h.events.events[0]?.payload).toMatchObject({
      reviewId,
      courseId: course.id,
      authorId: owner,
    });
    expect(h.reviews.locked).toEqual([reviewId, reviewId, reviewId]);
    expect(h.rateLimiter.hits.map((x) => x.rule)).toEqual([
      'reviewReply',
      'reviewReply',
      'reviewReply',
    ]);

    await h.deleteReply.execute({ actorId: owner, courseId: course.id, reviewId });
    await expect(
      h.deleteReply.execute({ actorId: owner, courseId: course.id, reviewId }),
    ).rejects.toBeInstanceOf(ReplyNotFound);
    expect(h.events.types().at(-1)).toBe('ReviewReplyDeleted');
  });

  it('resolves the review WITHIN the course: a foreign, deleted or suspended review is 404', async () => {
    const { h, owner, student, course } = setup();
    const otherCourse = h.catalog.add(h.users.add('Other owner'));
    const foreign = h.reviews.seed({ courseId: otherCourse.id, userId: student });
    const suspended = h.reviews.seed({
      courseId: course.id,
      userId: h.users.add('S'),
      suspended: true,
    });
    const deleted = h.reviews.seed({ courseId: course.id, userId: h.users.add('D') });
    h.reviews.stored(deleted).deletedAt = new Date();

    for (const reviewId of [foreign, suspended, deleted, randomUUID()]) {
      await expect(
        h.upsertReply.execute({ actorId: owner, courseId: course.id, reviewId, body: 'Hi' }),
      ).rejects.toBeInstanceOf(ReviewNotFound);
      await expect(
        h.deleteReply.execute({ actorId: owner, courseId: course.id, reviewId }),
      ).rejects.toBeInstanceOf(ReviewNotFound);
    }
    expect(h.reviews.replies).toHaveLength(0);
    expect(h.events.events).toHaveLength(0);
  });

  it('a hidden review can be replied to', async () => {
    const { h, owner, student, course } = setup();
    const reviewId = h.reviews.seed({
      courseId: course.id,
      userId: student,
      moderationStatus: 'HIDDEN',
    });
    await expect(
      h.upsertReply.execute({ actorId: owner, courseId: course.id, reviewId, body: 'Noted' }),
    ).resolves.toMatchObject({ reviewId });
  });
});

describe('ReportContent (D13, R9)', () => {
  const reason = 'SPAM' as const;

  it('201 then 200 (the existing report) on repeat; the third distinct reporter auto-hides with ReviewHidden', async () => {
    const { h, student, course } = setup();
    const reviewId = h.reviews.seed({ courseId: course.id, userId: student });
    const [r1, r2, r3] = [h.users.add('R1'), h.users.add('R2'), h.users.add('R3')];
    const report = (reporterId: string) =>
      h.reportContent.execute({
        subjectType: 'REVIEW',
        routeId: reviewId,
        reporterId,
        reason,
        comment: null,
      });

    const first = await report(r1);
    const repeat = await report(r1);
    await report(r2);
    expect(h.events.events).toHaveLength(0);
    const third = await report(r3);

    expect(first.created).toBe(true);
    expect(ReportSchema.parse(first.report)).toMatchObject({
      subjectType: 'REVIEW',
      subjectId: reviewId,
      reason,
      status: 'OPEN',
    });
    expect(repeat).toEqual({ created: false, report: first.report });
    expect(third.report.status).toBe('ACTIONED');
    expect(h.reviews.stored(reviewId).moderationStatus).toBe('HIDDEN');
    expect(h.events.types()).toEqual(['ReviewHidden']);
    expect(h.events.events[0]).toMatchObject({
      aggregateId: course.id,
      payload: { reviewId, courseId: course.id, actorId: null },
    });
    expect(h.rateLimiter.hits.map((x) => x.rule)).toEqual(['report', 'report', 'report', 'report']);
  });

  it('own content is 422; an invisible (hidden, suspended, deleted, unknown) review is 404', async () => {
    const { h, student, course } = setup();
    const visible = h.reviews.seed({ courseId: course.id, userId: student });
    const hidden = h.reviews.seed({
      courseId: course.id,
      userId: h.users.add('H'),
      moderationStatus: 'HIDDEN',
    });
    const suspended = h.reviews.seed({
      courseId: course.id,
      userId: h.users.add('S'),
      suspended: true,
    });
    const reporter = h.users.add('Reporter');
    const report = (routeId: string, reporterId = reporter) =>
      h.reportContent.execute({ subjectType: 'REVIEW', routeId, reporterId, reason, comment: 'x' });

    await expect(report(visible, student)).rejects.toBeInstanceOf(CannotReportOwnContent);
    for (const id of [hidden, suspended, randomUUID()]) {
      await expect(report(id)).rejects.toBeInstanceOf(ReviewNotFound);
    }
    // the author of a hidden review sees it, but there is nothing to report: 404 as well
    await expect(report(hidden, h.reviews.stored(hidden).userId)).rejects.toBeInstanceOf(
      ReviewNotFound,
    );
    expect(h.reports.reports).toHaveLength(0);
  });

  it('replies are addressed by the review id; auto-hide emits ReviewReplyHidden; the owner cannot report their reply', async () => {
    const h = createEngagementHarness({ autoHideReports: 1 });
    const { owner, student, course } = setup(h);
    const reviewId = h.reviews.seed({ courseId: course.id, userId: student });
    const replyId = h.reviews.seedReply(reviewId, owner);
    const report = (reporterId: string) =>
      h.reportContent.execute({
        subjectType: 'REVIEW_REPLY',
        routeId: reviewId,
        reporterId,
        reason: 'ABUSE',
        comment: null,
      });

    await expect(report(owner)).rejects.toBeInstanceOf(CannotReportOwnContent);
    const res = await report(student);

    expect(res.report).toMatchObject({ subjectType: 'REVIEW_REPLY', subjectId: reviewId });
    expect(h.reports.reports[0]?.subjectId).toBe(replyId);
    expect(h.events.events).toEqual([
      expect.objectContaining({
        type: 'ReviewReplyHidden',
        aggregateId: course.id,
        payload: expect.objectContaining({ reviewId, authorId: owner, actorId: null }),
      }),
    ]);
    // now hidden: the reply is no longer reportable
    await expect(report(h.users.add('Late'))).rejects.toBeInstanceOf(ReplyNotFound);
  });

  it('a review without a live, visible reply has no reportable reply (404 reply_not_found)', async () => {
    const { h, owner, student, course } = setup();
    const noReply = h.reviews.seed({ courseId: course.id, userId: student });
    const hiddenReview = h.reviews.seed({
      courseId: course.id,
      userId: h.users.add('X'),
      moderationStatus: 'HIDDEN',
    });
    h.reviews.seedReply(hiddenReview, owner);
    for (const routeId of [noReply, hiddenReview]) {
      await expect(
        h.reportContent.execute({
          subjectType: 'REVIEW_REPLY',
          routeId,
          reporterId: h.users.add('R'),
          reason,
          comment: null,
        }),
      ).rejects.toBeInstanceOf(ReplyNotFound);
    }
  });
});

describe('Wishlist (D19)', () => {
  it('add (idempotent), list newest first with the live card, states, remove (idempotent)', async () => {
    const { h, owner, course } = setup();
    const user = h.users.add('Shopper');
    const archived = h.catalog.add(owner, 'ARCHIVED');

    await h.addToWishlist.execute({ userId: user, courseId: course.id });
    await h.addToWishlist.execute({ userId: user, courseId: course.id });
    expect(h.wishlist.items).toHaveLength(1);
    expect(h.wishlist.lockedUsers).toEqual([user]);

    // an item already listed stays a no-op even after the course was archived
    h.wishlist.items.push({ userId: user, courseId: archived.id, addedAt: h.clock.next() });
    await h.addToWishlist.execute({ userId: user, courseId: archived.id });

    const page = await h.listWishlist.execute({ userId: user, limit: 1 });
    expect(WishlistPageSchema.parse(page).items).toEqual([
      expect.objectContaining({
        courseId: archived.id,
        available: false,
        instructor: { id: owner, displayName: 'Owner' },
      }),
    ]);
    const rest = await h.listWishlist.execute({
      userId: user,
      cursor: page.nextCursor ?? undefined,
      limit: 1,
    });
    expect(rest.items.map((i) => [i.courseId, i.available])).toEqual([[course.id, true]]);
    expect(rest.nextCursor).toBeNull();

    const unknown = randomUUID();
    await expect(
      h.wishlistStates.execute({ userId: user, courseIds: [unknown, course.id] }),
    ).resolves.toEqual({
      items: [
        { courseId: unknown, wishlisted: false },
        { courseId: course.id, wishlisted: true },
      ],
    });

    await h.removeFromWishlist.execute({ userId: user, courseId: course.id });
    await h.removeFromWishlist.execute({ userId: user, courseId: course.id });
    expect(h.wishlist.items.map((i) => i.courseId)).toEqual([archived.id]);
    expect(h.rateLimiter.hits.filter((x) => x.rule === 'wishlistWrite')).toHaveLength(5);
  });

  it('404 unknown course; 409 owned, enrolled or archived; 422 at the cap', async () => {
    const { h, owner, student, course } = setup();
    const user = h.users.add('Shopper');
    const archived = h.catalog.add(owner, 'ARCHIVED');

    await expect(
      h.addToWishlist.execute({ userId: user, courseId: randomUUID() }),
    ).rejects.toBeInstanceOf(CourseNotFound);
    await expect(
      h.addToWishlist.execute({ userId: owner, courseId: course.id }),
    ).rejects.toBeInstanceOf(CourseNotWishlistable);
    await expect(
      h.addToWishlist.execute({ userId: student, courseId: course.id }),
    ).rejects.toBeInstanceOf(CourseNotWishlistable);
    await expect(
      h.addToWishlist.execute({ userId: user, courseId: archived.id }),
    ).rejects.toBeInstanceOf(CourseNotWishlistable);

    for (let i = 0; i < WISHLIST_LIMITS.maxItems; i += 1) {
      h.wishlist.items.push({ userId: user, courseId: randomUUID(), addedAt: h.clock.next() });
    }
    await expect(
      h.addToWishlist.execute({ userId: user, courseId: course.id }),
    ).rejects.toBeInstanceOf(WishlistFull);
  });
});
