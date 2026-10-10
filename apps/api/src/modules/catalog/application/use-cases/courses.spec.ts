import { beforeEach, describe, expect, it } from 'vitest';
import { MediaAssetNotFound, MediaAssetUnusable, MediaPurposeMismatch } from '../../../media';
import {
  CategoryInactive,
  CategoryNotFound,
  CategoryNotLeaf,
  CourseInReview,
  CourseNotEditable,
  CourseNotFound,
  CoursePublishedCannotDelete,
  MarkdownNotAllowed,
  SlugFrozen,
  SlugTaken,
  VersionConflict,
} from '../../domain/catalog.errors';
import { testId } from '../testing/catalog.fakes';
import { type CatalogHarness, createCatalogHarness } from '../testing/catalog.harness';

const OWNER = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000b2';

describe('course working copy (use cases with fakes)', () => {
  let h: CatalogHarness;
  let leafId: string;

  beforeEach(async () => {
    h = createCatalogHarness();
    const group = await h.createCategory.execute({ name: 'Development' });
    leafId = (await h.createCategory.execute({ name: 'Web Development', parentId: group.id })).id;
  });

  /** Marks a course as published (what P2-T10's approve does) directly in the fake state. */
  function publish(courseId: string, pending: string | null = null): void {
    const course = h.world.state.courses.get(courseId);
    if (course === undefined) throw new Error('no course');
    const live = testId();
    h.world.state.revisions.set(live, {
      id: live,
      courseId,
      revisionNo: 1,
      kind: 'INITIAL',
      submittedAt: new Date(),
    });
    Object.assign(course, {
      status: 'PUBLISHED',
      publishedRevisionId: live,
      pendingRevisionId: pending,
      firstPublishedAt: new Date(),
    });
  }

  describe('CreateCourse', () => {
    it('creates a DRAFT with a generated slug, the CREATE transition and CourseCreated', async () => {
      const course = await h.createCourse.execute({
        ownerId: OWNER,
        title: 'Complete TypeScript Bootcamp',
        categoryId: leafId,
      });
      expect(course).toMatchObject({
        ownerId: OWNER,
        slug: 'complete-typescript-bootcamp',
        slugEditable: true,
        status: 'DRAFT',
        badge: 'DRAFT',
        version: 1,
        locked: false,
        categoryId: leafId,
        outcomes: [],
        pendingRevision: null,
        liveRevision: null,
        latestDecision: null,
        hasUnpublishedChanges: false,
      });
      expect(course.readiness.ready).toBe(false);
      expect(h.world.state.transitions).toEqual([
        expect.objectContaining({
          courseId: course.id,
          action: 'CREATE',
          prevTransitionId: null,
          fromStatus: null,
          toStatus: 'DRAFT',
          actorId: OWNER,
        }),
      ]);
      expect(h.world.state.events).toEqual([
        {
          type: 'CourseCreated',
          payload: expect.objectContaining({ courseId: course.id, ownerId: OWNER }),
        },
      ]);
    });

    it('suffixes -2, -3 on slug conflicts and retries a lost race', async () => {
      const a = await h.createCourse.execute({ ownerId: OWNER, title: 'Intro to Go' });
      const b = await h.createCourse.execute({ ownerId: OTHER, title: 'Intro to Go!' });
      h.courses.raceOnce.add('intro-to-go-3');
      const c = await h.createCourse.execute({ ownerId: OWNER, title: 'intro to go' });
      expect([a.slug, b.slug, c.slug]).toEqual(['intro-to-go', 'intro-to-go-2', 'intro-to-go-4']);
      expect(h.tx.runs).toBe(2 + 1 + 1 + 2); // 2 categories, a, b, c (lost race + retry)
    });

    it('validates the category: missing 404, group 422, inactive 422', async () => {
      const group = (await h.categories.listAll()).find((c) => c.depth === 1);
      await expect(
        h.createCourse.execute({ ownerId: OWNER, title: 'Hello world', categoryId: testId() }),
      ).rejects.toBeInstanceOf(CategoryNotFound);
      await expect(
        h.createCourse.execute({ ownerId: OWNER, title: 'Hello world', categoryId: group?.id }),
      ).rejects.toBeInstanceOf(CategoryNotLeaf);
      await h.updateCategory.execute({ id: group?.id ?? '', isActive: false });
      await expect(
        h.createCourse.execute({ ownerId: OWNER, title: 'Hello world', categoryId: leafId }),
      ).rejects.toBeInstanceOf(CategoryInactive);
      expect(h.world.state.courses.size).toBe(0);
    });
  });

  describe('UpdateCourse', () => {
    it('updates header, slug and bullets, bumping the version', async () => {
      const created = await h.createCourse.execute({ ownerId: OWNER, title: 'Original title' });
      const updated = await h.updateCourse.execute({
        actorId: OWNER,
        courseId: created.id,
        expectedVersion: 1,
        changes: {
          title: 'Better title',
          subtitle: 'A subtitle for the course',
          descriptionMd: '# Intro  \nTrailing spaces stay.  ',
          language: 'uz',
          level: 'BEGINNER',
          categoryId: leafId,
          slug: 'custom-slug',
          outcomes: ['One', 'Two'],
          requirements: ['A laptop'],
        },
      });
      expect(updated).toMatchObject({
        title: 'Better title',
        slug: 'custom-slug',
        descriptionMd: '# Intro  \nTrailing spaces stay.  ',
        language: 'uz',
        outcomes: ['One', 'Two'],
        requirements: ['A laptop'],
        version: 2,
      });
      const cleared = await h.updateCourse.execute({
        actorId: OWNER,
        courseId: created.id,
        changes: { subtitle: null, categoryId: null, outcomes: [] },
      });
      expect(cleared).toMatchObject({ subtitle: null, categoryId: null, outcomes: [], version: 3 });
    });

    it('rejects stale versions, foreign courses, unsafe markdown and taken slugs', async () => {
      const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Original title' });
      await h.createCourse.execute({ ownerId: OTHER, title: 'Taken slug here' });
      const update = (changes: object, extra: object = {}) =>
        h.updateCourse.execute({ actorId: OWNER, courseId: course.id, changes, ...extra });

      await expect(update({ title: 'New title' }, { expectedVersion: 7 })).rejects.toBeInstanceOf(
        VersionConflict,
      );
      await expect(
        h.updateCourse.execute({
          actorId: OTHER,
          courseId: course.id,
          changes: { title: 'Mine!!' },
        }),
      ).rejects.toBeInstanceOf(CourseNotFound);
      await expect(update({ descriptionMd: 'x <script>alert(1)</script>' })).rejects.toBeInstanceOf(
        MarkdownNotAllowed,
      );
      await expect(update({ slug: 'taken-slug-here' })).rejects.toBeInstanceOf(SlugTaken);
      expect((await h.getCourse.execute(course.id)).version).toBe(1);
    });

    it('freezes the slug after the first publication (other fields stay editable)', async () => {
      const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Original title' });
      publish(course.id);
      await expect(
        h.updateCourse.execute({
          actorId: OWNER,
          courseId: course.id,
          changes: { slug: 'new-one' },
        }),
      ).rejects.toBeInstanceOf(SlugFrozen);
      const same = await h.updateCourse.execute({
        actorId: OWNER,
        courseId: course.id,
        changes: { slug: course.slug, title: 'Edited after publish' },
      });
      expect(same).toMatchObject({
        slugEditable: false,
        badge: 'LIVE',
        hasUnpublishedChanges: true,
      });
    });

    it('locks the working copy while in review (course_in_review) and when archived', async () => {
      const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Original title' });
      publish(course.id, testId());
      await expect(
        h.updateCourse.execute({
          actorId: OWNER,
          courseId: course.id,
          changes: { title: 'Nope!' },
        }),
      ).rejects.toBeInstanceOf(CourseInReview);
      expect((await h.getCourse.execute(course.id)).badge).toBe('LIVE_UPDATE_PENDING');
      const stored = h.world.state.courses.get(course.id);
      if (stored) Object.assign(stored, { pendingRevisionId: null, status: 'ARCHIVED' });
      await expect(
        h.addSection.execute({ actorId: OWNER, courseId: course.id, title: 'S' }),
      ).rejects.toBeInstanceOf(CourseNotEditable);
    });
  });

  describe('thumbnail', () => {
    it('release-then-use on swap, clear releases, idempotent re-set', async () => {
      const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Thumbnail course' });
      const first = h.media.addAsset({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' });
      const second = h.media.addAsset({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' });
      const set = await h.setThumbnail.execute({
        actorId: OWNER,
        courseId: course.id,
        assetId: first.id,
      });
      expect(set).toMatchObject({ thumbnailAssetId: first.id, thumbnail: { id: first.id } });
      expect(h.media.usagesOf(first.id)).toEqual([`catalog.course_thumbnail|${course.id}`]);

      await h.setThumbnail.execute({ actorId: OWNER, courseId: course.id, assetId: first.id });
      expect(h.media.locked).toEqual([first.id]); // no-op: nothing locked again

      await h.setThumbnail.execute({ actorId: OWNER, courseId: course.id, assetId: second.id });
      expect(h.media.locked).toEqual([first.id, first.id, second.id]); // release old, use new
      expect(h.media.usagesOf(first.id)).toEqual([]);
      expect(h.media.usagesOf(second.id)).toEqual([`catalog.course_thumbnail|${course.id}`]);

      const cleared = await h.clearThumbnail.execute({ actorId: OWNER, courseId: course.id });
      expect(cleared.thumbnailAssetId).toBeNull();
      expect(h.media.usagesOf(second.id)).toEqual([]);
    });

    it('maps media errors and rolls the release back', async () => {
      const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Thumbnail course' });
      const mine = h.media.addAsset({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' });
      await h.setThumbnail.execute({ actorId: OWNER, courseId: course.id, assetId: mine.id });
      const foreign = h.media.addAsset({ ownerId: OTHER, purpose: 'COURSE_THUMBNAIL' });
      const video = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
      const failed = h.media.addAsset({
        ownerId: OWNER,
        purpose: 'COURSE_THUMBNAIL',
        status: 'FAILED',
      });
      const set = (assetId: string) =>
        h.setThumbnail.execute({ actorId: OWNER, courseId: course.id, assetId });
      await expect(set(foreign.id)).rejects.toBeInstanceOf(MediaAssetNotFound);
      await expect(set(video.id)).rejects.toBeInstanceOf(MediaPurposeMismatch);
      await expect(set(failed.id)).rejects.toBeInstanceOf(MediaAssetUnusable);
      expect(h.media.usagesOf(mine.id)).toEqual([`catalog.course_thumbnail|${course.id}`]);
      expect((await h.getCourse.execute(course.id)).thumbnailAssetId).toBe(mine.id);
    });
  });

  describe('DeleteCourse', () => {
    it('releases every usage, nulls references, appends DELETE and emits CourseDeleted', async () => {
      const course = await h.createCourse.execute({ ownerId: OWNER, title: 'To be deleted' });
      const section = await h.addSection.execute({
        actorId: OWNER,
        courseId: course.id,
        title: 'S1',
      });
      const lecture = await h.addLecture.execute({
        actorId: OWNER,
        courseId: course.id,
        sectionId: section.id,
        type: 'VIDEO',
        title: 'L1',
      });
      const thumb = h.media.addAsset({ ownerId: OWNER, purpose: 'COURSE_THUMBNAIL' });
      const video = h.media.addAsset({ ownerId: OWNER, purpose: 'LECTURE_VIDEO' });
      await h.setThumbnail.execute({ actorId: OWNER, courseId: course.id, assetId: thumb.id });
      await h.attachMedia.execute({
        actorId: OWNER,
        courseId: course.id,
        lectureId: lecture.id,
        assetId: video.id,
      });
      h.media.locked.length = 0;

      await h.deleteCourse.execute({ actorId: OWNER, courseId: course.id });

      expect(h.media.usagesOf(thumb.id)).toEqual([]);
      expect(h.media.usagesOf(video.id)).toEqual([]);
      expect(h.media.locked).toEqual([thumb.id, video.id].sort()); // ascending asset order
      const stored = h.world.state.courses.get(course.id);
      expect(stored?.deletedAt).not.toBeNull();
      expect(stored?.thumbnailAssetId).toBeNull();
      expect(h.world.state.lectures.get(lecture.id)?.mediaAssetId).toBeNull();
      const [create, del] = h.world.state.transitions;
      expect(del).toMatchObject({
        action: 'DELETE',
        prevTransitionId: create?.id,
        fromStatus: 'DRAFT',
        toStatus: 'DRAFT',
      });
      expect(h.world.state.events.map((e) => e.type)).toEqual(['CourseCreated', 'CourseDeleted']);
      await expect(h.getCourse.execute(course.id)).rejects.toBeInstanceOf(CourseNotFound);
      // The slug is free again.
      expect((await h.createCourse.execute({ ownerId: OWNER, title: 'To be deleted' })).slug).toBe(
        'to-be-deleted',
      );
    });

    it('refuses published courses, courses in review and other owners', async () => {
      const course = await h.createCourse.execute({ ownerId: OWNER, title: 'Keep me please' });
      await expect(
        h.deleteCourse.execute({ actorId: OTHER, courseId: course.id }),
      ).rejects.toBeInstanceOf(CourseNotFound);
      const stored = h.world.state.courses.get(course.id);
      if (stored) Object.assign(stored, { status: 'IN_REVIEW', pendingRevisionId: testId() });
      await expect(
        h.deleteCourse.execute({ actorId: OWNER, courseId: course.id }),
      ).rejects.toBeInstanceOf(CourseInReview);
      if (stored) Object.assign(stored, { status: 'DRAFT', pendingRevisionId: null });
      publish(course.id);
      await expect(
        h.deleteCourse.execute({ actorId: OWNER, courseId: course.id }),
      ).rejects.toBeInstanceOf(CoursePublishedCannotDelete);
    });
  });

  describe('ListMyCourses', () => {
    it('pages the owner courses newest change first with badges', async () => {
      const ids: string[] = [];
      for (const title of ['Course one', 'Course two', 'Course three']) {
        ids.push((await h.createCourse.execute({ ownerId: OWNER, title })).id);
      }
      await h.createCourse.execute({ ownerId: OTHER, title: 'Not mine at all' });
      const first = await h.listMyCourses.execute({ ownerId: OWNER, limit: 2 });
      expect(first.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
      expect(first.items[0]?.badge).toBe('DRAFT');
      expect(first.nextCursor).not.toBeNull();
      const second = await h.listMyCourses.execute({
        ownerId: OWNER,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((i) => i.id)).toEqual([ids[0]]);
      expect(second.nextCursor).toBeNull();
    });
  });
});
