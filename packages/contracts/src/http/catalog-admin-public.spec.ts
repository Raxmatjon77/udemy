import { describe, expect, it } from 'vitest';
import {
  BrowseCoursesQuerySchema,
  CourseCardPageSchema,
  CourseLandingSchema,
  CourseSlugParamsSchema,
  HLS_PLAYLIST_CONTENT_TYPE,
  LectureVariantPlaylistParamsSchema,
  RevisionLectureVariantPlaylistParamsSchema,
  ThumbnailQuerySchema,
} from './catalog-public';
import {
  AdminCategoryTreeResponseSchema,
  CategoryTreeResponseSchema,
  CreateCategoryRequestSchema,
  ReorderCategoriesRequestSchema,
  UpdateCategoryRequestSchema,
} from './categories';
import {
  AdminCoursePageSchema,
  AdminCoursesQuerySchema,
  ApproveRevisionRequestSchema,
  RejectRevisionRequestSchema,
  ReviewQueuePageSchema,
  RevisionReviewSchema,
  TakedownCourseRequestSchema,
} from './course-moderation';

const uuid = (n: number) => `0199c9a1-7d2e-7c4a-9b1e-${String(n).padStart(12, '0')}`;
const id = uuid(1);
const at = '2026-10-10T12:00:00.000Z';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('categories', () => {
  it('create: name 2–60, optional slug and parent', () => {
    expect(
      CreateCategoryRequestSchema.parse({ name: ' Development ', slug: 'Development' }),
    ).toEqual({ name: 'Development', slug: 'development' });
    expect(ok(CreateCategoryRequestSchema, { name: 'Web', parentId: id })).toBe(true);
    expect(ok(CreateCategoryRequestSchema, { name: 'W' })).toBe(false);
    expect(ok(CreateCategoryRequestSchema, { name: 'n'.repeat(61) })).toBe(false);
    expect(ok(CreateCategoryRequestSchema, { name: 'Web', slug: 'web dev' })).toBe(false);
  });

  it('update: at least one field', () => {
    expect(ok(UpdateCategoryRequestSchema, { isActive: false })).toBe(true);
    expect(ok(UpdateCategoryRequestSchema, { parentId: id })).toBe(true);
    expect(ok(UpdateCategoryRequestSchema, {})).toBe(false);
  });

  it('reorder: distinct ids, parent may be null', () => {
    expect(
      ok(ReorderCategoriesRequestSchema, { parentId: null, orderedIds: [uuid(1), uuid(2)] }),
    ).toBe(true);
    expect(
      ok(ReorderCategoriesRequestSchema, { parentId: id, orderedIds: [uuid(1), uuid(1)] }),
    ).toBe(false);
    expect(ok(ReorderCategoriesRequestSchema, { orderedIds: [uuid(1)] })).toBe(false);
    expect(ok(ReorderCategoriesRequestSchema, { parentId: null, orderedIds: [] })).toBe(false);
  });

  it('trees', () => {
    const leaf = { id: uuid(2), slug: 'web-development', name: 'Web Development' };
    expect(
      ok(CategoryTreeResponseSchema, {
        items: [{ id, slug: 'development', name: 'Development', children: [leaf] }],
      }),
    ).toBe(true);
    const adminLeaf = {
      id: uuid(2),
      parentId: id,
      depth: 2,
      slug: 'web-development',
      name: 'Web Development',
      position: 0,
      isActive: false,
      courseCount: 3,
    };
    const adminTree = {
      items: [
        { ...adminLeaf, id, parentId: null, depth: 1, courseCount: 0, children: [adminLeaf] },
      ],
    };
    expect(AdminCategoryTreeResponseSchema.parse(adminTree)).toEqual(adminTree);
    expect(
      ok(AdminCategoryTreeResponseSchema, {
        items: [{ ...adminTree.items[0], depth: 3 }],
      }),
    ).toBe(false);
  });
});

describe('public catalog', () => {
  it('browse query: limit ≤ 48 (default 24), q ≥ 3, filters', () => {
    expect(BrowseCoursesQuerySchema.parse({})).toEqual({ limit: 24 });
    expect(
      BrowseCoursesQuerySchema.parse({
        category: 'development',
        level: 'BEGINNER',
        language: 'pt-BR',
        q: ' rust ',
        limit: '48',
        cursor: '',
      }),
    ).toEqual({
      category: 'development',
      level: 'BEGINNER',
      language: 'pt-BR',
      q: 'rust',
      limit: 48,
    });
    expect(ok(BrowseCoursesQuerySchema, { limit: '49' })).toBe(false);
    expect(ok(BrowseCoursesQuerySchema, { q: 'ab' })).toBe(false);
    expect(ok(BrowseCoursesQuerySchema, { q: 'q'.repeat(101) })).toBe(false);
    expect(ok(BrowseCoursesQuerySchema, { category: 'Dev Ops' })).toBe(false);
    expect(ok(BrowseCoursesQuerySchema, { language: 'klingon' })).toBe(false);
  });

  it('slug params are not normalised', () => {
    expect(ok(CourseSlugParamsSchema, { slug: 'learn-rust' })).toBe(true);
    expect(ok(CourseSlugParamsSchema, { slug: 'Learn-Rust' })).toBe(false);
    expect(ok(CourseSlugParamsSchema, { slug: 's'.repeat(61) })).toBe(false);
  });

  it('thumbnail variant defaults to w750', () => {
    expect(ThumbnailQuerySchema.parse({})).toEqual({ variant: 'w750' });
    expect(ThumbnailQuerySchema.parse({ variant: 'w480' })).toEqual({ variant: 'w480' });
    expect(ok(ThumbnailQuerySchema, { variant: 'poster' })).toBe(false);
  });

  it('playlist params only accept HLS variant names', () => {
    expect(HLS_PLAYLIST_CONTENT_TYPE).toBe('application/vnd.apple.mpegurl');
    const params = { courseId: id, lectureId: id };
    for (const rendition of ['360p', '720p', '1080p', 'src1440p']) {
      expect(ok(LectureVariantPlaylistParamsSchema, { ...params, rendition }), rendition).toBe(
        true,
      );
    }
    for (const rendition of ['poster', 'w750', 'master', '720p.m3u8', '../../x', '%2e%2e']) {
      expect(ok(LectureVariantPlaylistParamsSchema, { ...params, rendition }), rendition).toBe(
        false,
      );
    }
    expect(
      ok(RevisionLectureVariantPlaylistParamsSchema, {
        revisionId: id,
        lectureId: id,
        rendition: '480p',
      }),
    ).toBe(true);
    expect(
      ok(LectureVariantPlaylistParamsSchema, { ...params, courseId: 'x', rendition: '720p' }),
    ).toBe(false);
  });

  it('cards and landing', () => {
    const card = {
      id,
      slug: 'learn-rust',
      title: 'Learn Rust',
      subtitle: 'From zero to systems programming',
      level: 'BEGINNER',
      language: 'en',
      category: { id, slug: 'programming', name: 'Programming' },
      instructor: null,
      lectureCount: 12,
      videoSeconds: 7200,
      publishedAt: at,
    };
    expect(ok(CourseCardPageSchema, { items: [card], nextCursor: 'abc' })).toBe(true);
    expect(
      ok(CourseCardPageSchema, { items: [{ ...card, lectureCount: -1 }], nextCursor: null }),
    ).toBe(false);

    const landing = {
      id,
      slug: 'learn-rust',
      revisionId: id,
      title: 'Learn Rust',
      subtitle: null,
      descriptionMd: '# Hi',
      language: 'en',
      level: 'BEGINNER',
      outcomes: ['a', 'b', 'c', 'd'],
      requirements: [],
      categoryPath: [
        { id, slug: 'development', name: 'Development' },
        { id, slug: 'programming', name: 'Programming' },
      ],
      instructor: {
        id,
        displayName: 'Jane',
        headline: null,
        bio: null,
        avatarUrl: null,
        isInstructor: true,
      },
      sections: [
        {
          id,
          title: 'Intro',
          objective: null,
          lectures: [
            { id, title: 'Welcome', type: 'VIDEO', durationSeconds: 300, isPreview: true },
          ],
        },
      ],
      totals: { sectionCount: 1, lectureCount: 1, videoSeconds: 300 },
      publishedAt: at,
      lastUpdatedAt: at,
    };
    expect(CourseLandingSchema.parse(landing)).toEqual(landing);
    expect(ok(CourseLandingSchema, { ...landing, revisionId: null })).toBe(false);
  });
});

describe('admin moderation', () => {
  it('approve / reject / takedown bodies', () => {
    expect(ok(ApproveRevisionRequestSchema, {})).toBe(true);
    expect(ok(ApproveRevisionRequestSchema, { note: 'Great course', expectedVersion: 4 })).toBe(
      true,
    );
    expect(ok(ApproveRevisionRequestSchema, { note: '' })).toBe(false);
    expect(ok(ApproveRevisionRequestSchema, { expectedVersion: 0 })).toBe(false);
    expect(ok(RejectRevisionRequestSchema, { reason: 'r'.repeat(10) })).toBe(true);
    expect(ok(RejectRevisionRequestSchema, { reason: 'r'.repeat(2000), expectedVersion: 2 })).toBe(
      true,
    );
    expect(ok(RejectRevisionRequestSchema, { reason: 'r'.repeat(9) })).toBe(false);
    expect(ok(RejectRevisionRequestSchema, { reason: 'r'.repeat(2001) })).toBe(false);
    expect(ok(RejectRevisionRequestSchema, {})).toBe(false);
    expect(ok(TakedownCourseRequestSchema, { reason: 'Copyright complaint received.' })).toBe(true);
    expect(ok(TakedownCourseRequestSchema, {})).toBe(false);
    expect(ok(TakedownCourseRequestSchema, { reason: 'spam' })).toBe(false);
  });

  it('admin course search query', () => {
    expect(AdminCoursesQuerySchema.parse({ status: '', q: '', ownerId: '' })).toEqual({
      limit: 20,
    });
    expect(ok(AdminCoursesQuerySchema, { status: 'ARCHIVED', ownerId: id, q: 'rust' })).toBe(true);
    expect(ok(AdminCoursesQuerySchema, { ownerId: 'me' })).toBe(false);
    expect(ok(AdminCoursesQuerySchema, { q: 'ru' })).toBe(false);
  });

  it('queue and course pages', () => {
    expect(
      ok(ReviewQueuePageSchema, {
        items: [
          {
            courseId: id,
            revisionId: id,
            revisionNo: 1,
            kind: 'INITIAL',
            title: 'Learn Rust',
            owner: { id, displayName: 'Jane' },
            submittedAt: at,
          },
        ],
        nextCursor: null,
      }),
    ).toBe(true);
    expect(
      ok(AdminCoursePageSchema, {
        items: [
          {
            id,
            slug: 'learn-rust',
            title: 'Learn Rust',
            status: 'PUBLISHED',
            badge: 'LIVE',
            owner: { id, displayName: 'Jane', banned: true },
            pendingRevisionId: null,
            liveRevisionId: id,
            firstPublishedAt: at,
            updatedAt: at,
          },
        ],
        nextCursor: null,
      }),
    ).toBe(true);
  });

  it('revision review with diff', () => {
    const review = {
      course: {
        id,
        slug: 'learn-rust',
        status: 'PUBLISHED',
        version: 9,
        owner: { id, displayName: 'Jane' },
        pendingRevisionId: uuid(3),
        liveRevisionId: uuid(2),
      },
      revision: {
        id: uuid(3),
        courseId: id,
        revisionNo: 3,
        kind: 'UPDATE',
        state: 'PENDING',
        contentHash: 'a'.repeat(64),
        title: 'Learn Rust',
        subtitle: null,
        descriptionMd: null,
        language: 'en',
        level: 'EXPERT',
        category: { id, slug: 'programming', name: 'Programming' },
        thumbnailAssetId: null,
        outcomes: [],
        requirements: [],
        sections: [
          {
            id,
            position: 0,
            title: 'Intro',
            objective: null,
            lectures: [
              {
                id: uuid(10),
                sectionId: id,
                position: 0,
                type: 'ARTICLE',
                title: 'Read me',
                descriptionMd: null,
                isPreview: false,
                mediaAssetId: null,
                durationSeconds: null,
                articleBodyMd: '# Hello',
              },
            ],
          },
        ],
        submittedBy: { id, displayName: 'Jane' },
        submitterNote: null,
        submittedAt: at,
      },
      diff: {
        baseRevisionId: uuid(2),
        changedFields: ['level', 'outcomes'],
        sections: { added: [], removed: [], changed: [], moved: [] },
        lectures: {
          added: [uuid(10)],
          removed: [{ id: uuid(11), title: 'Old lecture', type: 'VIDEO' }],
          changed: [],
          moved: [],
        },
      },
      assets: [],
    };
    expect(RevisionReviewSchema.parse(review)).toEqual(review);
    expect(
      ok(RevisionReviewSchema, {
        ...review,
        diff: { ...review.diff, changedFields: ['price'] },
      }),
    ).toBe(false);
    expect(
      ok(RevisionReviewSchema, {
        ...review,
        revision: { ...review.revision, contentHash: 'XYZ' },
      }),
    ).toBe(false);
  });
});
