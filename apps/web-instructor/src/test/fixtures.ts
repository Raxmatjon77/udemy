import {
  AssetViewSchema,
  CategoryTreeResponseSchema,
  CourseDetailSchema,
  CourseHistoryResponseSchema,
  CurriculumSchema,
  LectureSchema,
  type AssetView,
  type CategoryTreeResponse,
  type CourseDetail,
  type CourseHistoryResponse,
  type Curriculum,
  type Lecture,
} from '@udemy/contracts';

/*
 * Contract-valid fixtures: every builder parses its result with the contracts schema, so a
 * fixture that drifts from the API contract fails the test that uses it.
 */

export const IDS = {
  owner: '0b1f6d1e-0000-4000-8000-000000000001',
  course: '0b1f6d1e-0000-4000-8000-0000000000c1',
  category: '0b1f6d1e-0000-4000-8000-0000000000a2',
  group: '0b1f6d1e-0000-4000-8000-0000000000a1',
  sectionA: '0b1f6d1e-0000-4000-8000-0000000000b1',
  sectionB: '0b1f6d1e-0000-4000-8000-0000000000b2',
  lecture1: '0b1f6d1e-0000-4000-8000-0000000000d1',
  lecture2: '0b1f6d1e-0000-4000-8000-0000000000d2',
  lecture3: '0b1f6d1e-0000-4000-8000-0000000000d3',
  asset: '0b1f6d1e-0000-4000-8000-0000000000e1',
  revision: '0b1f6d1e-0000-4000-8000-0000000000f1',
} as const;

const NOW = '2026-10-10T10:00:00.000Z';

export function categoryTree(): CategoryTreeResponse {
  return CategoryTreeResponseSchema.parse({
    items: [
      {
        id: IDS.group,
        slug: 'development',
        name: 'Development',
        children: [{ id: IDS.category, slug: 'web-development', name: 'Web Development' }],
      },
    ],
  });
}

export function courseDetail(overrides: Partial<CourseDetail> = {}): CourseDetail {
  return CourseDetailSchema.parse({
    id: IDS.course,
    ownerId: IDS.owner,
    slug: 'nestjs-in-practice',
    slugEditable: true,
    title: 'NestJS in practice',
    subtitle: null,
    descriptionMd: null,
    language: 'en',
    level: null,
    categoryId: IDS.category,
    thumbnailAssetId: null,
    thumbnail: null,
    outcomes: [],
    requirements: [],
    status: 'DRAFT',
    badge: 'DRAFT',
    version: 3,
    locked: false,
    pendingRevision: null,
    liveRevision: null,
    latestDecision: null,
    readiness: {
      ready: false,
      issues: [
        {
          code: 'SUBTITLE_MISSING',
          sectionId: null,
          lectureId: null,
          required: null,
          actual: null,
        },
        { code: 'TOO_FEW_OUTCOMES', sectionId: null, lectureId: null, required: 4, actual: 0 },
      ],
    },
    hasUnpublishedChanges: false,
    firstPublishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

/** A course waiting for review: locked (design D2). */
export function lockedCourse(): CourseDetail {
  return courseDetail({
    status: 'IN_REVIEW',
    badge: 'IN_REVIEW',
    locked: true,
    pendingRevision: { id: IDS.revision, revisionNo: 1, kind: 'INITIAL', submittedAt: NOW },
  });
}

export function asset(overrides: Partial<AssetView> = {}): AssetView {
  return AssetViewSchema.parse({
    id: IDS.asset,
    ownerId: IDS.owner,
    purpose: 'LECTURE_VIDEO',
    status: 'READY',
    originalFilename: 'intro.mp4',
    sizeBytes: 20 * 1024 * 1024,
    progressPct: null,
    failureCode: null,
    durationSeconds: 125,
    width: 1280,
    height: 720,
    renditions: ['360p', '720p', 'poster'],
    purged: false,
    createdAt: NOW,
    ...overrides,
  });
}

export function lecture(
  overrides: Partial<Lecture> & Pick<Lecture, 'id' | 'sectionId' | 'position'>,
): Lecture {
  return LectureSchema.parse({
    type: 'VIDEO',
    title: `Lecture ${overrides.id.slice(-2)}`,
    descriptionMd: null,
    isPreview: false,
    mediaAssetId: null,
    asset: null,
    articleLength: null,
    updatedAt: NOW,
    ...overrides,
  });
}

/** Two sections: A = [lecture1, lecture2], B = [lecture3]. */
export function curriculum(overrides: Partial<Curriculum> = {}): Curriculum {
  return CurriculumSchema.parse({
    courseId: IDS.course,
    version: 3,
    locked: false,
    sections: [
      {
        id: IDS.sectionA,
        title: 'Getting started',
        objective: null,
        position: 0,
        updatedAt: NOW,
        lectures: [
          lecture({ id: IDS.lecture1, sectionId: IDS.sectionA, position: 0, title: 'Welcome' }),
          lecture({
            id: IDS.lecture2,
            sectionId: IDS.sectionA,
            position: 1,
            title: 'Setup',
            type: 'ARTICLE',
            articleLength: 120,
          }),
        ],
      },
      {
        id: IDS.sectionB,
        title: 'Deep dive',
        objective: null,
        position: 1,
        updatedAt: NOW,
        lectures: [
          lecture({ id: IDS.lecture3, sectionId: IDS.sectionB, position: 0, title: 'Modules' }),
        ],
      },
    ],
    totals: { sectionCount: 2, lectureCount: 3, previewCount: 0, videoSeconds: 0 },
    ...overrides,
  });
}

export function history(): CourseHistoryResponse {
  return CourseHistoryResponseSchema.parse({
    items: [
      {
        id: '0b1f6d1e-0000-4000-8000-000000000101',
        action: 'CREATE',
        fromStatus: null,
        toStatus: 'DRAFT',
        revisionId: null,
        revisionNo: null,
        actor: { id: IDS.owner, displayName: 'Jane Instructor', isModerator: false },
        reason: null,
        occurredAt: NOW,
      },
    ],
  });
}
