import { randomUUID } from 'node:crypto';
import {
  AdminEnrollmentSchema,
  AdminUserEnrollmentsSchema,
  EnrollmentSchema,
  LearningCardPageSchema,
} from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors';
import {
  AlreadyEnrolled,
  CannotPurchaseOwnCourse,
  CourseNotForSale,
  CourseNotFound,
  CourseNotFree,
  EnrollmentNotFound,
  InvalidStateTransition,
  UserNotFound,
} from '../../domain/enrollment.errors';
import { createEnrollmentHarness, FAKE_TRX } from '../testing/enrollment.fakes';

const REASON = 'Support case 1234: goodwill access';

describe('EnrollFree', () => {
  function setup() {
    const h = createEnrollmentHarness();
    const student = h.people.add('Student');
    const course = h.catalog.add();
    h.prices.prices.set(course.id, '0.00');
    return { h, student, course };
  }

  it('grants FREE (201), then is idempotent (200, same enrollment, one event)', async () => {
    const { h, student, course } = setup();

    const first = await h.enrollFree.execute({ userId: student, courseId: course.id });
    const again = await h.enrollFree.execute({ userId: student, courseId: course.id });

    expect(first.created).toBe(true);
    expect(EnrollmentSchema.parse(first.enrollment)).toMatchObject({
      userId: student,
      courseId: course.id,
      status: 'ACTIVE',
      source: 'FREE',
      orderLineId: null,
      revokedAt: null,
    });
    expect(again).toEqual({ enrollment: first.enrollment, created: false });
    expect(h.events.events).toHaveLength(1);
    expect(h.rateLimiter.hits).toEqual([student, student]);
  });

  it('an existing ACTIVE enrollment from another source is returned unchanged (200)', async () => {
    const { h, student, course } = setup();
    await h.facade.grant(FAKE_TRX, {
      userId: student,
      courseId: course.id,
      source: 'ORDER',
      orderLineId: randomUUID(),
    });
    const result = await h.enrollFree.execute({ userId: student, courseId: course.id });
    expect(result.created).toBe(false);
    expect(result.enrollment.source).toBe('ORDER');
  });

  it('re-enrolling after a revoke is a REGRANT (201)', async () => {
    const { h, student, course } = setup();
    await h.enrollFree.execute({ userId: student, courseId: course.id });
    await h.facade.revoke(FAKE_TRX, {
      userId: student,
      courseId: course.id,
      cause: 'ADMIN',
      actorId: randomUUID(),
      reason: REASON,
    });
    const back = await h.enrollFree.execute({ userId: student, courseId: course.id });
    expect(back.created).toBe(true);
    expect(h.events.events.at(-1)?.payload).toMatchObject({ regrant: true });
  });

  it.each([
    ['an unknown course', 'unknown', CourseNotFound],
    ['an archived course', 'archived', CourseNotForSale],
    ['a course without a price', 'unpriced', CourseNotForSale],
    ['a paid course', 'paid', CourseNotFree],
    ['the own course', 'own', CannotPurchaseOwnCourse],
  ] as const)('refuses %s and writes nothing', async (_label, kind, error) => {
    const { h, student } = setup();
    const course = h.catalog.add({
      status: kind === 'archived' ? 'ARCHIVED' : 'PUBLISHED',
      ownerId: kind === 'own' ? student : undefined,
    });
    if (kind !== 'unpriced') h.prices.prices.set(course.id, kind === 'paid' ? '19.99' : '0.00');
    const courseId = kind === 'unknown' ? randomUUID() : course.id;

    await expect(h.enrollFree.execute({ userId: student, courseId })).rejects.toThrow(error);
    expect(h.tx.runs).toBe(0);
    expect(h.repo.calls).toEqual([]);
  });

  it('counts the attempt first: a limited user is refused before any read', async () => {
    const { h, student, course } = setup();
    h.rateLimiter.limit = 1;
    await h.enrollFree.execute({ userId: student, courseId: course.id });
    await expect(h.enrollFree.execute({ userId: student, courseId: course.id })).rejects.toThrow(
      RateLimitedError,
    );
    expect(h.tx.runs).toBe(1);
  });
});

describe('ListMyLearning', () => {
  it('pages ACTIVE enrollments newest first with live course cards; no progress value is null', async () => {
    const h = createEnrollmentHarness();
    const student = h.people.add('Student');
    const instructor = h.people.add('Ada Instructor');
    const banned = h.people.add('Banned', true);
    const c1 = h.catalog.add({ ownerId: instructor, title: 'First' });
    const c2 = h.catalog.add({ ownerId: banned, title: 'Second', status: 'ARCHIVED' });
    const c3 = h.catalog.add({ ownerId: instructor, title: 'Third' });
    const revoked = h.catalog.add({ ownerId: instructor });
    for (const c of [c1, c2, c3, revoked]) {
      await h.facade.grant(FAKE_TRX, { userId: student, courseId: c.id, source: 'FREE' });
    }
    await h.facade.revoke(FAKE_TRX, {
      userId: student,
      courseId: revoked.id,
      cause: 'ADMIN',
      actorId: randomUUID(),
      reason: REASON,
    });
    // another user's enrollment never shows
    await h.facade.grant(FAKE_TRX, { userId: randomUUID(), courseId: c1.id, source: 'FREE' });

    const page1 = LearningCardPageSchema.parse(
      await h.myLearning.execute({ userId: student, limit: 2 }),
    );
    expect(page1.items.map((c) => c.title)).toEqual(['Third', 'Second']);
    expect(page1.items[1]).toMatchObject({
      courseId: c2.id,
      slug: c2.slug,
      archived: true,
      instructor: null,
      hasThumbnail: true,
      source: 'FREE',
      progress: null,
    });
    expect(page1.items[0]?.instructor).toEqual({ id: instructor, displayName: 'Ada Instructor' });
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await h.myLearning.execute({
      userId: student,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.map((c) => c.title)).toEqual(['First']);
    expect(page2.nextCursor).toBeNull();
  });

  it('skips courses catalog no longer knows, and an empty page makes no catalog call', async () => {
    const h = createEnrollmentHarness();
    const student = h.people.add();
    expect(await h.myLearning.execute({ userId: student, limit: 24 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(h.catalog.summaryCalls).toEqual([]);

    await h.facade.grant(FAKE_TRX, { userId: student, courseId: randomUUID(), source: 'FREE' });
    const page = await h.myLearning.execute({ userId: student, limit: 24 });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(h.progress.calls).toEqual([]);
  });

  it('progress comes from COURSE_PROGRESS: one batch per page, 0 kept, absent is null', async () => {
    const h = createEnrollmentHarness();
    const student = h.people.add('Student');
    const instructor = h.people.add('Ada Instructor');
    const started = h.catalog.add({ ownerId: instructor, title: 'Started' });
    const fresh = h.catalog.add({ ownerId: instructor, title: 'Fresh' });
    const done = h.catalog.add({ ownerId: instructor, title: 'Done' });
    const unknown = h.catalog.add({ ownerId: instructor, title: 'Unknown' });
    for (const c of [started, fresh, done, unknown]) {
      await h.facade.grant(FAKE_TRX, { userId: student, courseId: c.id, source: 'FREE' });
    }
    h.progress.set(student, started.id, 29);
    h.progress.set(student, fresh.id, 0);
    h.progress.set(student, done.id, 100);
    // another user's progress never leaks into this user's cards
    h.progress.set(randomUUID(), unknown.id, 50);

    const page = LearningCardPageSchema.parse(
      await h.myLearning.execute({ userId: student, limit: 24 }),
    );
    expect(Object.fromEntries(page.items.map((c) => [c.title, c.progress]))).toEqual({
      Started: 29,
      Fresh: 0,
      Done: 100,
      Unknown: null,
    });
    expect(h.progress.calls).toHaveLength(1);
    expect(h.progress.calls[0]?.userId).toBe(student);
    expect([...(h.progress.calls[0]?.courseIds ?? [])].sort()).toEqual(
      [started.id, fresh.id, done.id, unknown.id].sort(),
    );
  });

  it('rejects a cursor it did not produce (422)', async () => {
    const h = createEnrollmentHarness();
    await expect(
      h.myLearning.execute({ userId: randomUUID(), limit: 5, cursor: 'Zm9v' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('Admin enrollments', () => {
  function setup() {
    const h = createEnrollmentHarness();
    const admin = h.people.add('Admin');
    const student = h.people.add('Student');
    const course = h.catalog.add({ title: 'Course A' });
    return { h, admin, student, course };
  }

  it('grant: ADMIN source with the audited reason; 409 already_enrolled leaves no trace', async () => {
    const { h, admin, student, course } = setup();
    const input = { actorId: admin, userId: student, courseId: course.id, reason: REASON };

    const view = AdminEnrollmentSchema.parse(await h.adminGrant.execute(input));
    expect(view).toMatchObject({
      userId: student,
      status: 'ACTIVE',
      source: 'ADMIN',
      course: { id: course.id, slug: course.slug, title: 'Course A', archived: false },
    });
    expect(view.transitions).toEqual([
      expect.objectContaining({ action: 'GRANT', source: 'ADMIN', reason: REASON, actorId: admin }),
    ]);

    await expect(h.adminGrant.execute(input)).rejects.toThrow(AlreadyEnrolled);
    expect(h.events.events).toHaveLength(1);
    expect(h.repo.transitions).toHaveLength(1);
  });

  it('grant: 404 for an unknown user or course; archived courses qualify (D13)', async () => {
    const { h, admin, student, course } = setup();
    await expect(
      h.adminGrant.execute({
        actorId: admin,
        userId: randomUUID(),
        courseId: course.id,
        reason: REASON,
      }),
    ).rejects.toThrow(UserNotFound);
    await expect(
      h.adminGrant.execute({
        actorId: admin,
        userId: student,
        courseId: randomUUID(),
        reason: REASON,
      }),
    ).rejects.toThrow(CourseNotFound);
    const archived = h.catalog.add({ status: 'ARCHIVED' });
    const view = await h.adminGrant.execute({
      actorId: admin,
      userId: student,
      courseId: archived.id,
      reason: REASON,
    });
    expect(view.course.archived).toBe(true);
  });

  it('revoke: ACTIVE -> REVOKED with the admin as actor; 409 the second time; 404 unknown', async () => {
    const { h, admin, student, course } = setup();
    const granted = await h.adminGrant.execute({
      actorId: admin,
      userId: student,
      courseId: course.id,
      reason: REASON,
    });
    const revokeReason = 'Chargeback confirmed by support';

    const view = AdminEnrollmentSchema.parse(
      await h.adminRevoke.execute({
        actorId: admin,
        enrollmentId: granted.id,
        reason: revokeReason,
      }),
    );
    expect(view).toMatchObject({ status: 'REVOKED', revokeReason: 'ADMIN' });
    expect(view.transitions.map((t) => [t.action, t.reason, t.actorId])).toEqual([
      ['GRANT', REASON, admin],
      ['REVOKE', revokeReason, admin],
    ]);
    expect(new Set(view.transitions.map((t) => t.id)).size).toBe(2);

    await expect(
      h.adminRevoke.execute({ actorId: admin, enrollmentId: granted.id, reason: revokeReason }),
    ).rejects.toThrow(InvalidStateTransition);
    await expect(
      h.adminRevoke.execute({ actorId: admin, enrollmentId: randomUUID(), reason: revokeReason }),
    ).rejects.toThrow(EnrollmentNotFound);
    expect(h.events.events.map((e) => e.type)).toEqual(['granted', 'revoked']);
  });

  it('list: every enrollment of the user with transitions; deleted courses keep a null title', async () => {
    const { h, admin, student, course } = setup();
    const gone = randomUUID();
    await h.facade.grant(FAKE_TRX, { userId: student, courseId: course.id, source: 'FREE' });
    await h.facade.grant(FAKE_TRX, { userId: student, courseId: gone, source: 'FREE' });
    await h.facade.revoke(FAKE_TRX, {
      userId: student,
      courseId: course.id,
      cause: 'ADMIN',
      actorId: admin,
      reason: REASON,
    });

    const list = AdminUserEnrollmentsSchema.parse(await h.adminList.execute(student));
    expect(list.items.map((e) => [e.courseId, e.status, e.transitions.length])).toEqual([
      [gone, 'ACTIVE', 1],
      [course.id, 'REVOKED', 2],
    ]);
    expect(list.items[0]?.course).toEqual({ id: gone, slug: null, title: null, archived: false });
    expect((await h.adminList.execute(admin)).items).toEqual([]);
    await expect(h.adminList.execute(randomUUID())).rejects.toThrow(UserNotFound);
  });

  it('list: course summaries are fetched in batches of at most 100 ids', async () => {
    const { h, student } = setup();
    for (let i = 0; i < 205; i += 1) {
      await h.facade.grant(FAKE_TRX, { userId: student, courseId: randomUUID(), source: 'FREE' });
    }
    const list = await h.adminList.execute(student);
    expect(list.items).toHaveLength(205);
    expect(h.catalog.summaryCalls.map((ids) => ids.length)).toEqual([100, 100, 5]);
  });
});
