import {
  AdminCourseRowSchema,
  CourseArchived,
  CoursePublished,
  CourseRejected,
  CourseRestored,
  CourseSubmissionWithdrawn,
  CourseSubmittedForReview,
} from '@udemy/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors';
import {
  CourseInReview,
  CourseNotFound,
  CourseNotReady,
  InvalidCatalogField,
  InvalidStateTransition,
  NothingToReview,
  RestoreForbidden,
  ReviewAlreadyPending,
  RevisionNotFound,
  SelfDecisionForbidden,
  VersionConflict,
} from '../../domain/catalog.errors';
import { CatalogSettings } from '../catalog-settings';
import { type CatalogHarness, createCatalogHarness } from '../testing/catalog.harness';

const OWNER = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000b2';
const ADMIN = '00000000-0000-7000-8000-0000000000c3';

const DESCRIPTION = `${'This course teaches TypeScript from the ground up. '.repeat(6)}`;
const ARTICLE = 'An article body that is clearly longer than fifty characters in total.';

describe('course lifecycle and moderation (use cases with fakes)', () => {
  let h: CatalogHarness;
  let leafId: string;
  let groupId: string;

  beforeEach(async () => {
    h = createCatalogHarness(new CatalogSettings({ minLectures: 2, minVideoSeconds: 600 }));
    const group = await h.createCategory.execute({ name: 'Development' });
    groupId = group.id;
    leafId = (await h.createCategory.execute({ name: 'Web Development', parentId: group.id })).id;
    h.people.people.set(OWNER, { displayName: 'Owner Name', banned: false });
    h.people.people.set(ADMIN, { displayName: 'Admin Name', banned: false });
  });

  /** A course that passes readiness: header, thumbnail, 4 outcomes, a video and an article. */
  async function readyCourse(): Promise<{ courseId: string; videoId: string; articleId: string }> {
    const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Ready course title' });
    const as = { actorId: OWNER, courseId: course.id };
    await h.updateCourse.execute({
      ...as,
      changes: {
        subtitle: 'A subtitle for the course',
        descriptionMd: DESCRIPTION,
        language: 'en',
        level: 'BEGINNER',
        categoryId: leafId,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      },
    });
    const thumb = h.media.addAsset({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' });
    await h.setThumbnail.execute({ ...as, assetId: thumb.id });
    const section = await h.addSection.execute({ ...as, title: 'Section' });
    const video = await h.addLecture.execute({
      ...as,
      sectionId: section.id,
      type: 'VIDEO',
      title: 'Video',
    });
    const asset = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
    await h.attachMedia.execute({ ...as, lectureId: video.id, assetId: asset.id });
    const article = await h.addLecture.execute({
      ...as,
      sectionId: section.id,
      type: 'ARTICLE',
      title: 'Article',
    });
    await h.saveArticle.execute({ ...as, lectureId: article.id, bodyMd: ARTICLE });
    return { courseId: course.id, videoId: video.id, articleId: article.id };
  }

  const events = (type: string): unknown[] =>
    h.world.state.events.filter((e) => e.type === type).map((e) => e.payload);
  const pins = (revisionId: string): string[] =>
    [...h.world.state.usages].filter((u) => u.endsWith(`|catalog.course_revision|${revisionId}`));

  it('submit: snapshot, pins, IN_REVIEW, SUBMIT transition with prev = head, event', async () => {
    const { courseId } = await readyCourse();
    const { revisionId, revisionNo } = await h.submit.execute({
      actorId: OWNER,
      courseId,
      note: 'Please review',
    });
    expect(revisionNo).toBe(1);
    const course = await h.getCourse.execute(courseId);
    expect(course).toMatchObject({
      status: 'IN_REVIEW',
      badge: 'IN_REVIEW',
      locked: true,
      pendingRevision: { id: revisionId, revisionNo: 1, kind: 'INITIAL' },
    });
    expect(pins(revisionId)).toHaveLength(2); // thumbnail + video
    const chain = h.world.state.transitions.filter((t) => t.courseId === courseId);
    const submit = chain.at(-1);
    expect(submit).toMatchObject({ action: 'SUBMIT', fromStatus: 'DRAFT', toStatus: 'IN_REVIEW' });
    expect(submit?.prevTransitionId).toBe(chain.at(-2)?.id);
    const [payload] = events('CourseSubmittedForReview');
    expect(CourseSubmittedForReview.parsePayload(payload)).toMatchObject({
      revisionId,
      kind: 'INITIAL',
      ownerId: OWNER,
    });
    expect(h.world.state.snapshots.get(revisionId)?.submitterNote).toBe('Please review');
    // D2: locked while pending; a second submit is 409
    await expect(
      h.updateCourse.execute({ actorId: OWNER, courseId, changes: { title: 'Changed title' } }),
    ).rejects.toBeInstanceOf(CourseInReview);
    await expect(h.submit.execute({ actorId: OWNER, courseId })).rejects.toBeInstanceOf(
      ReviewAlreadyPending,
    );
  });

  it('submit: not ready -> course_not_ready with every issue, nothing written', async () => {
    const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Empty course title' });
    const before = h.world.state.transitions.length;
    const error = await h.submit.execute({ actorId: OWNER, courseId: course.id }).catch((e) => e);
    expect(error).toBeInstanceOf(CourseNotReady);
    const codes = (error as CourseNotReady).readinessIssues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['SUBTITLE_MISSING', 'THUMBNAIL_MISSING', 'NO_SECTIONS']),
    );
    expect(h.world.state.transitions).toHaveLength(before);
    expect(h.world.state.snapshots.size).toBe(0);
  });

  it('submit: other owners get 404; the rate limiter runs first', async () => {
    const { courseId } = await readyCourse();
    await expect(h.submit.execute({ actorId: OTHER, courseId })).rejects.toBeInstanceOf(
      CourseNotFound,
    );
    h.rateLimiter.failNext = new RateLimitedError('slow down', { retryAfterMs: 1000 });
    await expect(h.submit.execute({ actorId: OWNER, courseId })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(h.world.state.snapshots.size).toBe(0);
  });

  it('full cycle: approve -> edit -> update rejected -> resubmit -> approve (pins follow)', async () => {
    const { courseId, articleId } = await readyCourse();
    const r1 = await h.submit.execute({ actorId: OWNER, courseId });

    await expect(
      h.approve.execute({ actorId: OWNER, courseId, revisionId: r1.revisionId }),
    ).rejects.toBeInstanceOf(SelfDecisionForbidden);
    await expect(
      h.approve.execute({
        actorId: ADMIN,
        courseId,
        revisionId: r1.revisionId,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(VersionConflict);

    const live = await h.approve.execute({
      actorId: ADMIN,
      courseId,
      revisionId: r1.revisionId,
      note: 'Looks good',
    });
    expect(live).toMatchObject({
      status: 'PUBLISHED',
      badge: 'LIVE',
      slugEditable: false,
      pendingRevision: null,
      liveRevision: { id: r1.revisionId },
      hasUnpublishedChanges: false,
    });
    expect(live.firstPublishedAt).not.toBeNull();
    expect(CoursePublished.parsePayload(events('CoursePublished')[0])).toMatchObject({
      kind: 'INITIAL',
      decidedBy: ADMIN,
      slug: live.slug,
    });
    // an identical update is nothing to review
    await expect(h.submit.execute({ actorId: OWNER, courseId })).rejects.toBeInstanceOf(
      NothingToReview,
    );

    await h.saveArticle.execute({
      actorId: OWNER,
      courseId,
      lectureId: articleId,
      bodyMd: `${ARTICLE} Edited.`,
    });
    expect((await h.getCourse.execute(courseId)).hasUnpublishedChanges).toBe(true);
    const r2 = await h.submit.execute({ actorId: OWNER, courseId });
    expect(r2.revisionNo).toBe(2);
    expect((await h.getCourse.execute(courseId)).badge).toBe('LIVE_UPDATE_PENDING');

    const rejected = await h.reject.execute({
      actorId: ADMIN,
      courseId,
      revisionId: r2.revisionId,
      reason: 'Please fix the article.',
    });
    expect(rejected).toMatchObject({ status: 'PUBLISHED', badge: 'LIVE_UPDATE_REJECTED' });
    expect(rejected.latestDecision).toMatchObject({ action: 'REJECT', revisionId: r2.revisionId });
    expect(pins(r2.revisionId)).toEqual([]);
    expect(pins(r1.revisionId)).toHaveLength(2);
    expect(CourseRejected.parsePayload(events('CourseRejected')[0])).toMatchObject({
      kind: 'UPDATE',
      reason: 'Please fix the article.',
    });
    // a decided revision cannot be decided again
    await expect(
      h.approve.execute({ actorId: ADMIN, courseId, revisionId: r2.revisionId }),
    ).rejects.toBeInstanceOf(InvalidStateTransition);

    const r3 = await h.submit.execute({ actorId: OWNER, courseId });
    await h.approve.execute({ actorId: ADMIN, courseId, revisionId: r3.revisionId });
    expect(pins(r1.revisionId)).toEqual([]); // superseded
    expect(pins(r3.revisionId)).toHaveLength(2);
    const detail = await h.getCourse.execute(courseId);
    expect(detail).toMatchObject({ badge: 'LIVE', liveRevision: { id: r3.revisionId } });

    const history = await h.history.execute({ courseId, viewerIsModerator: false });
    expect(history.items.map((i) => i.action)).toEqual([
      'CREATE',
      'SUBMIT',
      'APPROVE',
      'SUBMIT',
      'REJECT',
      'SUBMIT',
      'APPROVE',
    ]);
    expect(history.items[2]?.actor).toEqual({
      id: null,
      displayName: 'Moderator',
      isModerator: true,
    });
    expect(history.items[1]?.actor).toEqual({
      id: OWNER,
      displayName: 'Owner Name',
      isModerator: false,
    });
    const asAdmin = await h.history.execute({ courseId, viewerIsModerator: true });
    expect(asAdmin.items[2]?.actor).toEqual({
      id: ADMIN,
      displayName: 'Admin Name',
      isModerator: true,
    });
    expect(asAdmin.items[4]).toMatchObject({ revisionNo: 2, reason: 'Please fix the article.' });
  });

  it('withdraw: back to DRAFT, pins released; approve of the withdrawn revision is 409', async () => {
    const { courseId } = await readyCourse();
    const r1 = await h.submit.execute({ actorId: OWNER, courseId });
    await expect(h.withdraw.execute({ actorId: OTHER, courseId })).rejects.toBeInstanceOf(
      CourseNotFound,
    );
    const detail = await h.withdraw.execute({ actorId: OWNER, courseId });
    expect(detail).toMatchObject({ status: 'DRAFT', badge: 'DRAFT', locked: false });
    expect(pins(r1.revisionId)).toEqual([]);
    expect(
      CourseSubmissionWithdrawn.parsePayload(events('CourseSubmissionWithdrawn')[0]),
    ).toMatchObject({ cause: 'OWNER', revisionId: r1.revisionId });
    await expect(h.withdraw.execute({ actorId: OWNER, courseId })).rejects.toBeInstanceOf(
      InvalidStateTransition,
    );
    const r2 = await h.submit.execute({ actorId: OWNER, courseId });
    await expect(
      h.approve.execute({ actorId: ADMIN, courseId, revisionId: r1.revisionId }),
    ).rejects.toBeInstanceOf(InvalidStateTransition);
    await expect(
      h.approve.execute({
        actorId: ADMIN,
        courseId,
        revisionId: '00000000-0000-7000-8000-ffffffffffff',
      }),
    ).rejects.toBeInstanceOf(RevisionNotFound);
    const live = await h.approve.execute({ actorId: ADMIN, courseId, revisionId: r2.revisionId });
    expect(live.status).toBe('PUBLISHED');
  });

  it('reject of a first submission -> REJECTED, editable and resubmittable', async () => {
    const { courseId } = await readyCourse();
    const r1 = await h.submit.execute({ actorId: OWNER, courseId });
    const rejected = await h.reject.execute({
      actorId: ADMIN,
      courseId,
      revisionId: r1.revisionId,
      reason: 'Not good enough yet.',
    });
    expect(rejected).toMatchObject({ status: 'REJECTED', badge: 'REJECTED', locked: false });
    const r2 = await h.submit.execute({ actorId: OWNER, courseId });
    expect(r2.revisionNo).toBe(2);
    expect((await h.getCourse.execute(courseId)).status).toBe('IN_REVIEW');
  });

  it('archive with a pending update auto-withdraws; takedown blocks owner restore', async () => {
    const { courseId, articleId } = await readyCourse();
    const r1 = await h.submit.execute({ actorId: OWNER, courseId });
    await expect(
      h.archive.execute({ actorId: OWNER, courseId, byAdmin: false }),
    ).rejects.toBeInstanceOf(InvalidStateTransition); // only PUBLISHED
    await h.approve.execute({ actorId: ADMIN, courseId, revisionId: r1.revisionId });
    await h.saveArticle.execute({
      actorId: OWNER,
      courseId,
      lectureId: articleId,
      bodyMd: `${ARTICLE}!`,
    });
    const r2 = await h.submit.execute({ actorId: OWNER, courseId });

    const archived = await h.archive.execute({
      actorId: OWNER,
      courseId,
      reason: 'Taking a break',
      byAdmin: false,
    });
    expect(archived).toMatchObject({
      status: 'ARCHIVED',
      badge: 'ARCHIVED',
      pendingRevision: null,
    });
    expect(pins(r2.revisionId)).toEqual([]);
    expect(pins(r1.revisionId)).toHaveLength(2); // the live revision keeps its pins
    const chain = h.world.state.transitions.filter((t) => t.courseId === courseId).slice(-2);
    expect(chain.map((t) => [t.action, t.reason])).toEqual([
      ['WITHDRAW', 'ARCHIVED'],
      ['ARCHIVE', 'Taking a break'],
    ]);
    expect(
      CourseSubmissionWithdrawn.parsePayload(events('CourseSubmissionWithdrawn')[0]).cause,
    ).toBe('ARCHIVED');
    expect(CourseArchived.parsePayload(events('CourseArchived')[0]).byAdmin).toBe(false);

    const restored = await h.restore.execute({ actorId: OWNER, courseId, byAdmin: false });
    expect(restored).toMatchObject({ status: 'PUBLISHED', badge: 'LIVE' });

    await expect(
      h.archive.execute({ actorId: ADMIN, courseId, reason: 'short', byAdmin: true }),
    ).rejects.toBeInstanceOf(InvalidCatalogField);
    await h.archive.execute({
      actorId: ADMIN,
      courseId,
      reason: 'Violates the content policy.',
      byAdmin: true,
    });
    await expect(
      h.restore.execute({ actorId: OWNER, courseId, byAdmin: false }),
    ).rejects.toBeInstanceOf(RestoreForbidden);
    const back = await h.restore.execute({ actorId: ADMIN, courseId, byAdmin: true });
    expect(back.status).toBe('PUBLISHED');
    expect(CourseRestored.parsePayload(events('CourseRestored').at(-1))).toMatchObject({
      actorId: ADMIN,
    });
  });

  it('admin course list: archive actor and reason of ARCHIVED courses only', async () => {
    const { courseId } = await readyCourse();
    const r1 = await h.submit.execute({ actorId: OWNER, courseId });
    await h.approve.execute({ actorId: ADMIN, courseId, revisionId: r1.revisionId });
    const row = async () => (await h.adminCourses.execute({ limit: 10 })).items[0];
    expect(await row()).toMatchObject({
      status: 'PUBLISHED',
      archivedBy: null,
      archiveReason: null,
    });

    await h.archive.execute({ actorId: OWNER, courseId, byAdmin: false });
    expect(await row()).toMatchObject({
      status: 'ARCHIVED',
      archivedBy: { id: OWNER, displayName: 'Owner Name', isModerator: false },
      archiveReason: null,
    });

    await h.restore.execute({ actorId: OWNER, courseId, byAdmin: false });
    expect(await row()).toMatchObject({ archivedBy: null, archiveReason: null });

    // A later takedown wins over the earlier owner archive.
    await h.archive.execute({
      actorId: ADMIN,
      courseId,
      reason: 'Violates the content policy.',
      byAdmin: true,
    });
    const takenDown = await row();
    expect(takenDown).toMatchObject({
      status: 'ARCHIVED',
      archivedBy: { id: ADMIN, displayName: 'Admin Name', isModerator: true },
      archiveReason: 'Violates the content policy.',
    });
    expect(AdminCourseRowSchema.parse(takenDown)).toEqual(takenDown);
  });

  it('admin queue (oldest first, keyset), revision review with diff, admin course list', async () => {
    const a = await readyCourse();
    const b = await readyCourse();
    const ra = await h.submit.execute({ actorId: OWNER, courseId: a.courseId });
    const rb = await h.submit.execute({ actorId: OWNER, courseId: b.courseId });

    const first = await h.reviewQueue.execute({ limit: 1 });
    expect(first.items.map((i) => i.revisionId)).toEqual([ra.revisionId]);
    expect(first.items[0]?.owner).toEqual({ id: OWNER, displayName: 'Owner Name' });
    const second = await h.reviewQueue.execute({ limit: 1, cursor: first.nextCursor ?? '' });
    expect(second.items.map((i) => i.revisionId)).toEqual([rb.revisionId]);
    expect(second.nextCursor).toBeNull();

    const initial = await h.revisionReview.execute(ra.revisionId);
    expect(initial.revision).toMatchObject({ state: 'PENDING', kind: 'INITIAL', revisionNo: 1 });
    expect(initial.diff.baseRevisionId).toBeNull();
    expect(initial.diff.fieldChanges).toEqual([]);
    // The snapshot's leaf category carries its depth-1 group.
    expect(initial.revision.category).toEqual({
      id: leafId,
      slug: 'web-development',
      name: 'Web Development',
      parent: { id: groupId, slug: 'development', name: 'Development' },
    });
    expect(initial.diff.lectures.added).toEqual([a.videoId, a.articleId]);
    expect(initial.assets).toHaveLength(2);

    await h.approve.execute({ actorId: ADMIN, courseId: a.courseId, revisionId: ra.revisionId });
    await h.updateLecture.execute({
      actorId: OWNER,
      courseId: a.courseId,
      lectureId: a.videoId,
      patch: { title: 'Video renamed' },
    });
    await h.updateCourse.execute({
      actorId: OWNER,
      courseId: a.courseId,
      changes: { title: 'Ready course title v2', requirements: ['A laptop'] },
    });
    const update = await h.submit.execute({ actorId: OWNER, courseId: a.courseId });
    const review = await h.revisionReview.execute(update.revisionId);
    expect(review.diff).toMatchObject({
      baseRevisionId: ra.revisionId,
      changedFields: ['title', 'requirements'],
      fieldChanges: [
        { field: 'title', before: 'Ready course title', after: 'Ready course title v2' },
        { field: 'requirements', before: [], after: ['A laptop'] },
      ],
      lectures: { added: [], removed: [], changed: [a.videoId], moved: [] },
    });
    expect((await h.revisionReview.execute(ra.revisionId)).revision.state).toBe('LIVE');
    await expect(h.revisionReview.execute(OTHER)).rejects.toBeInstanceOf(RevisionNotFound);

    h.people.people.set(OWNER, { displayName: 'Owner Name', banned: true });
    const page = await h.adminCourses.execute({ limit: 10, status: 'PUBLISHED' });
    expect(page.items).toEqual([
      expect.objectContaining({
        id: a.courseId,
        badge: 'LIVE_UPDATE_PENDING',
        owner: { id: OWNER, displayName: 'Owner Name', banned: true },
        liveRevisionId: ra.revisionId,
        pendingRevisionId: update.revisionId,
      }),
    ]);
  });
});
