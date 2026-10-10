import {
  AdminCategoryTreeResponseSchema,
  AdminCoursePageSchema,
  CategorySchema,
  CourseDetailSchema,
  ReviewQueuePageSchema,
  RevisionLectureDownloadResponseSchema,
  RevisionReviewSchema,
  type AdminCategoryTreeResponse,
  type AdminCourseRow,
  type Category,
  type CourseDetail,
  type RevisionLectureDownloadResponse,
  type ReviewQueueItem,
  type RevisionReview,
} from '@udemy/contracts';

/*
 * Response fixtures for the component tests, always parsed with the contracts schemas: if the
 * API contract changes, these fail loudly instead of the UI being tested against stale shapes.
 */

/** Deterministic UUIDs: `uuid(1)` → `00000000-0000-4000-8000-000000000001`. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const ADMIN_ID = uuid(900);
export const OWNER_ID = uuid(901);
export const COURSE_ID = uuid(100);
export const REVISION_ID = uuid(200);
export const LIVE_REVISION_ID = uuid(199);

export const SECTION_1 = uuid(301);
export const SECTION_2 = uuid(302);
export const LECTURE_VIDEO = uuid(401);
export const LECTURE_ARTICLE = uuid(402);
export const LECTURE_RESOURCE = uuid(403);
export const LECTURE_MOVED = uuid(404);
export const ASSET_VIDEO = uuid(501);
export const ASSET_THUMB = uuid(502);
export const ASSET_RESOURCE = uuid(503);

const HASH = 'a'.repeat(64);

export function queueItem(n: number, overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    courseId: uuid(1000 + n),
    revisionId: uuid(2000 + n),
    revisionNo: 1,
    kind: 'INITIAL',
    title: `Course number ${n}`,
    owner: { id: uuid(3000 + n), displayName: `Instructor ${n}` },
    submittedAt: new Date(Date.UTC(2026, 9, 1, 8, n)).toISOString(),
    ...overrides,
  };
}

export function queuePage(items: ReviewQueueItem[], nextCursor: string | null) {
  return ReviewQueuePageSchema.parse({ items, nextCursor });
}

function asset(id: string, purpose: 'LECTURE_VIDEO' | 'COURSE_THUMBNAIL' | 'LECTURE_RESOURCE') {
  return {
    id,
    ownerId: OWNER_ID,
    purpose,
    status: 'READY' as const,
    originalFilename:
      purpose === 'LECTURE_VIDEO'
        ? 'intro.mp4'
        : purpose === 'COURSE_THUMBNAIL'
          ? 'cover.png'
          : 'slides.pdf',
    sizeBytes: 5_000_000,
    progressPct: null,
    failureCode: null,
    durationSeconds: purpose === 'LECTURE_VIDEO' ? 754 : null,
    width: purpose === 'LECTURE_RESOURCE' ? null : 1280,
    height: purpose === 'LECTURE_RESOURCE' ? null : 720,
    renditions: purpose === 'LECTURE_VIDEO' ? ['360p', '720p'] : [],
    purged: false,
    createdAt: '2026-09-30T10:00:00.000Z',
  };
}

/** An UPDATE revision of a live course with a diff touching most kinds of change. */
export function revisionReview(
  overrides: {
    kind?: 'INITIAL' | 'UPDATE';
    state?: RevisionReview['revision']['state'];
    version?: number;
    ownerId?: string;
    pendingRevisionId?: string | null;
    /** A diff from before `fieldChanges` / removed-lecture sections / category parents. */
    legacy?: boolean;
  } = {},
): RevisionReview {
  const legacy = overrides.legacy ?? false;
  const kind = overrides.kind ?? 'UPDATE';
  const ownerId = overrides.ownerId ?? OWNER_ID;
  const base = kind === 'UPDATE' ? LIVE_REVISION_ID : null;
  return RevisionReviewSchema.parse({
    course: {
      id: COURSE_ID,
      slug: 'typescript-from-zero',
      status: kind === 'UPDATE' ? 'PUBLISHED' : 'IN_REVIEW',
      version: overrides.version ?? 7,
      owner: { id: ownerId, displayName: 'Jane Teacher' },
      pendingRevisionId:
        overrides.pendingRevisionId === undefined ? REVISION_ID : overrides.pendingRevisionId,
      liveRevisionId: base,
    },
    revision: {
      id: REVISION_ID,
      courseId: COURSE_ID,
      revisionNo: kind === 'UPDATE' ? 3 : 1,
      kind,
      state: overrides.state ?? 'PENDING',
      contentHash: HASH,
      title: 'TypeScript from zero',
      subtitle: 'Types, generics and tooling for working developers',
      descriptionMd: 'Learn **TypeScript** properly.\n\n## What is inside\n\n- Types\n- Generics',
      language: 'en',
      level: 'BEGINNER',
      category: {
        id: uuid(601),
        slug: 'web-development',
        name: 'Web development',
        ...(legacy ? {} : { parent: { id: uuid(600), slug: 'development', name: 'Development' } }),
      },
      thumbnailAssetId: ASSET_THUMB,
      outcomes: ['Write typed code', 'Use generics', 'Configure tsc', 'Read compiler errors'],
      requirements: ['Basic JavaScript'],
      sections: [
        {
          id: SECTION_1,
          position: 0,
          title: 'Getting started',
          objective: 'Set up your tools',
          lectures: [
            {
              id: LECTURE_VIDEO,
              sectionId: SECTION_1,
              position: 0,
              type: 'VIDEO',
              title: 'Welcome video',
              descriptionMd: null,
              isPreview: true,
              mediaAssetId: ASSET_VIDEO,
              durationSeconds: 754,
              articleBodyMd: null,
            },
            {
              id: LECTURE_ARTICLE,
              sectionId: SECTION_1,
              position: 1,
              type: 'ARTICLE',
              title: 'Reading list',
              descriptionMd: null,
              isPreview: false,
              mediaAssetId: null,
              durationSeconds: null,
              articleBodyMd: 'Read the *handbook* first.\n\n```ts\nconst x: number = 1;\n```',
            },
          ],
        },
        {
          id: SECTION_2,
          position: 1,
          title: 'Generics',
          objective: null,
          lectures: [
            {
              id: LECTURE_MOVED,
              sectionId: SECTION_2,
              position: 0,
              type: 'VIDEO',
              title: 'Generic functions',
              descriptionMd: null,
              isPreview: false,
              mediaAssetId: null,
              durationSeconds: null,
              articleBodyMd: null,
            },
            {
              id: LECTURE_RESOURCE,
              sectionId: SECTION_2,
              position: 1,
              type: 'RESOURCE',
              title: 'Cheat sheet',
              descriptionMd: null,
              isPreview: false,
              mediaAssetId: ASSET_RESOURCE,
              durationSeconds: null,
              articleBodyMd: null,
            },
          ],
        },
      ],
      submittedBy: { id: ownerId, displayName: 'Jane Teacher' },
      submitterNote: 'Fixed the audio in the welcome video.',
      submittedAt: '2026-10-01T09:30:00.000Z',
    },
    diff:
      kind === 'UPDATE'
        ? {
            baseRevisionId: base,
            changedFields: ['title', 'descriptionMd', 'outcomes'],
            ...(legacy
              ? {}
              : {
                  fieldChanges: [
                    { field: 'title', before: 'TypeScript basics', after: 'TypeScript from zero' },
                    {
                      field: 'descriptionMd',
                      before: 'Learn *TypeScript*.',
                      after:
                        'Learn **TypeScript** properly.\n\n## What is inside\n\n- Types\n- Generics',
                    },
                    {
                      field: 'outcomes',
                      before: ['Write typed code'],
                      after: [
                        'Write typed code',
                        'Use generics',
                        'Configure tsc',
                        'Read compiler errors',
                      ],
                    },
                  ],
                }),
            sections: {
              added: [SECTION_2],
              removed: [{ id: uuid(399), title: 'Old appendix' }],
              changed: [SECTION_1],
              moved: [],
            },
            lectures: {
              added: [LECTURE_RESOURCE],
              removed: [
                {
                  id: uuid(499),
                  title: 'Outdated setup guide',
                  type: 'ARTICLE',
                  ...(legacy ? {} : { sectionId: uuid(399), sectionTitle: 'Old appendix' }),
                },
              ],
              changed: [LECTURE_VIDEO],
              moved: [LECTURE_MOVED],
            },
          }
        : {
            baseRevisionId: null,
            changedFields: [],
            sections: { added: [SECTION_1, SECTION_2], removed: [], changed: [], moved: [] },
            lectures: {
              added: [LECTURE_VIDEO, LECTURE_ARTICLE, LECTURE_MOVED, LECTURE_RESOURCE],
              removed: [],
              changed: [],
              moved: [],
            },
          },
    assets: [
      asset(ASSET_VIDEO, 'LECTURE_VIDEO'),
      asset(ASSET_THUMB, 'COURSE_THUMBNAIL'),
      asset(ASSET_RESOURCE, 'LECTURE_RESOURCE'),
    ],
  });
}

/** The CourseDetail the decision, takedown and restore endpoints answer with. */
export function courseDetail(overrides: Partial<CourseDetail> = {}): CourseDetail {
  return CourseDetailSchema.parse({
    id: COURSE_ID,
    ownerId: OWNER_ID,
    slug: 'typescript-from-zero',
    slugEditable: false,
    title: 'TypeScript from zero',
    subtitle: null,
    descriptionMd: null,
    language: 'en',
    level: 'BEGINNER',
    categoryId: null,
    thumbnailAssetId: null,
    thumbnail: null,
    outcomes: [],
    requirements: [],
    status: 'PUBLISHED',
    badge: 'LIVE',
    version: 8,
    locked: false,
    pendingRevision: null,
    liveRevision: null,
    latestDecision: null,
    readiness: { ready: true, issues: [] },
    hasUnpublishedChanges: false,
    firstPublishedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  });
}

export function courseRow(n: number, overrides: Partial<AdminCourseRow> = {}): AdminCourseRow {
  return {
    id: uuid(7000 + n),
    slug: `course-${n}`,
    title: `Course ${n}`,
    status: 'PUBLISHED',
    badge: 'LIVE',
    owner: { id: uuid(8000 + n), displayName: `Owner ${n}`, banned: false },
    pendingRevisionId: null,
    liveRevisionId: uuid(9000 + n),
    firstPublishedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function coursePage(items: AdminCourseRow[], nextCursor: string | null = null) {
  return AdminCoursePageSchema.parse({ items, nextCursor });
}

export const GROUP_DEV = uuid(11);
export const GROUP_DESIGN = uuid(12);
export const LEAF_WEB = uuid(21);
export const LEAF_MOBILE = uuid(22);
export const LEAF_DATA = uuid(23);
export const LEAF_UX = uuid(24);

export function categoryTree(): AdminCategoryTreeResponse {
  const leaf = (
    id: string,
    parentId: string,
    position: number,
    name: string,
    courseCount = 0,
    isActive = true,
  ) => ({
    id,
    parentId,
    depth: 2,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    position,
    isActive,
    courseCount,
  });
  return AdminCategoryTreeResponseSchema.parse({
    items: [
      {
        id: GROUP_DEV,
        parentId: null,
        depth: 1,
        slug: 'development',
        name: 'Development',
        position: 0,
        isActive: true,
        courseCount: 0,
        children: [
          leaf(LEAF_WEB, GROUP_DEV, 0, 'Web development', 12),
          leaf(LEAF_MOBILE, GROUP_DEV, 1, 'Mobile development', 3),
          leaf(LEAF_DATA, GROUP_DEV, 2, 'Data science', 0, false),
        ],
      },
      {
        id: GROUP_DESIGN,
        parentId: null,
        depth: 1,
        slug: 'design',
        name: 'Design',
        position: 1,
        isActive: true,
        courseCount: 0,
        children: [leaf(LEAF_UX, GROUP_DESIGN, 0, 'UX design', 0)],
      },
    ],
  });
}

export function category(overrides: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return CategorySchema.parse({
    parentId: null,
    depth: 1,
    slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
    position: 0,
    isActive: true,
    ...overrides,
  });
}

/** The media host of the test env (vitest.config `MEDIA_PUBLIC_ORIGIN`). */
export const MEDIA_ORIGIN = 'http://127.0.0.1:9000';

/** A presigned URL response (`SignedUrl`), valid for `seconds`. */
export function signedUrl(key: string, seconds = 300): RevisionLectureDownloadResponse {
  return RevisionLectureDownloadResponseSchema.parse({
    url: `${MEDIA_ORIGIN}/udemy-media/${key}?X-Amz-Signature=abc`,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
  });
}
