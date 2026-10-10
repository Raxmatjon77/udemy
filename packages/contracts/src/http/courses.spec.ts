import { describe, expect, it } from 'vitest';
import {
  ArchiveCourseRequestSchema,
  AttachAssetRequestSchema,
  CourseDetailSchema,
  CourseHistoryResponseSchema,
  CourseNotReadyProblemSchema,
  CreateCourseRequestSchema,
  CreateLectureRequestSchema,
  CreateSectionRequestSchema,
  CurriculumSchema,
  MyCoursesQuerySchema,
  ReorderCurriculumRequestSchema,
  SaveArticleRequestSchema,
  SubmitCourseRequestSchema,
  SubmitCourseResponseSchema,
  UpdateCourseRequestSchema,
  UpdateLectureRequestSchema,
  UpdateSectionRequestSchema,
} from './courses';

const uuid = (n: number) => `0199c9a1-7d2e-7c4a-9b1e-${String(n).padStart(12, '0')}`;
const id = uuid(1);
const at = '2026-10-10T12:00:00.000Z';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('create and list', () => {
  it('CreateCourseRequest: title 5–60, optional category', () => {
    expect(CreateCourseRequestSchema.parse({ title: '  Learn Rust  ' })).toEqual({
      title: 'Learn Rust',
    });
    expect(ok(CreateCourseRequestSchema, { title: 'Learn Rust', categoryId: id })).toBe(true);
    expect(ok(CreateCourseRequestSchema, { title: 'Rust' })).toBe(false);
    expect(ok(CreateCourseRequestSchema, { title: 't'.repeat(61) })).toBe(false);
    expect(ok(CreateCourseRequestSchema, { title: 'Learn Rust', categoryId: 'x' })).toBe(false);
  });

  it('MyCoursesQuery: limit ≤ 50, optional status', () => {
    expect(MyCoursesQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(MyCoursesQuerySchema.parse({ status: '', limit: '50' })).toEqual({ limit: 50 });
    expect(MyCoursesQuerySchema.parse({ status: 'IN_REVIEW' })).toEqual({
      status: 'IN_REVIEW',
      limit: 20,
    });
    expect(ok(MyCoursesQuerySchema, { limit: '51' })).toBe(false);
    expect(ok(MyCoursesQuerySchema, { status: 'LIVE' })).toBe(false);
  });
});

describe('UpdateCourseRequestSchema', () => {
  it('accepts partial updates and null clears', () => {
    const body = {
      subtitle: null,
      descriptionMd: 'A **great** course',
      language: 'uz',
      level: 'ALL_LEVELS',
      categoryId: null,
      slug: 'learn-rust',
      outcomes: ['Write safe code'],
      requirements: [],
      expectedVersion: 3,
    };
    expect(UpdateCourseRequestSchema.parse(body)).toEqual(body);
    expect(ok(UpdateCourseRequestSchema, { title: 'New title' })).toBe(true);
  });

  it('requires a field besides expectedVersion', () => {
    expect(ok(UpdateCourseRequestSchema, {})).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { expectedVersion: 2 })).toBe(false);
  });

  it('rejects boundary violations', () => {
    expect(ok(UpdateCourseRequestSchema, { title: null })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { subtitle: 'too short' })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { language: 'xx' })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { language: 'EN' })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { level: 'ADVANCED' })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { slug: 'not a slug' })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { slug: null })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { outcomes: Array(11).fill('x') })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { descriptionMd: 'd'.repeat(20_001) })).toBe(false);
    expect(ok(UpdateCourseRequestSchema, { title: 'Valid title', expectedVersion: 0 })).toBe(false);
  });
});

describe('curriculum requests', () => {
  it('sections', () => {
    expect(ok(CreateSectionRequestSchema, { title: 'Intro' })).toBe(true);
    expect(ok(CreateSectionRequestSchema, { title: 'Intro', objective: 'o'.repeat(200) })).toBe(
      true,
    );
    expect(ok(CreateSectionRequestSchema, { title: 'Intro', objective: 'o'.repeat(201) })).toBe(
      false,
    );
    expect(ok(CreateSectionRequestSchema, { title: 's'.repeat(81) })).toBe(false);
    expect(ok(UpdateSectionRequestSchema, { objective: null })).toBe(true);
    expect(ok(UpdateSectionRequestSchema, {})).toBe(false);
  });

  it('lectures', () => {
    for (const type of ['VIDEO', 'ARTICLE', 'RESOURCE']) {
      expect(ok(CreateLectureRequestSchema, { type, title: 'Welcome' })).toBe(true);
    }
    expect(ok(CreateLectureRequestSchema, { type: 'QUIZ', title: 'Welcome' })).toBe(false);
    expect(ok(CreateLectureRequestSchema, { type: 'VIDEO', title: '' })).toBe(false);
    expect(ok(UpdateLectureRequestSchema, { isPreview: true })).toBe(true);
    expect(ok(UpdateLectureRequestSchema, { descriptionMd: null })).toBe(true);
    expect(ok(UpdateLectureRequestSchema, { descriptionMd: 'd'.repeat(2001) })).toBe(false);
    expect(ok(UpdateLectureRequestSchema, { type: 'ARTICLE' })).toBe(false);
  });

  it('article and attachments', () => {
    expect(ok(SaveArticleRequestSchema, { bodyMd: '' })).toBe(true);
    expect(ok(SaveArticleRequestSchema, { bodyMd: 'a'.repeat(100_001) })).toBe(false);
    expect(ok(SaveArticleRequestSchema, {})).toBe(false);
    expect(ok(AttachAssetRequestSchema, { assetId: id })).toBe(true);
    expect(ok(AttachAssetRequestSchema, { assetId: '../x' })).toBe(false);
  });
});

describe('ReorderCurriculumRequestSchema', () => {
  const body = {
    sections: [
      { sectionId: uuid(1), lectureIds: [uuid(10), uuid(11)] },
      { sectionId: uuid(2), lectureIds: [] },
    ],
  };

  it('accepts a full order, including empty sections', () => {
    expect(ReorderCurriculumRequestSchema.parse(body)).toEqual(body);
    expect(ok(ReorderCurriculumRequestSchema, { sections: [] })).toBe(true);
  });

  it('rejects duplicates anywhere', () => {
    expect(
      ok(ReorderCurriculumRequestSchema, {
        sections: [...body.sections, { sectionId: uuid(1), lectureIds: [] }],
      }),
    ).toBe(false);
    expect(
      ok(ReorderCurriculumRequestSchema, {
        sections: [
          { sectionId: uuid(1), lectureIds: [uuid(10)] },
          { sectionId: uuid(2), lectureIds: [uuid(10)] },
        ],
      }),
    ).toBe(false);
  });

  it('enforces the curriculum limits', () => {
    const sections = (count: number, perSection: number) =>
      Array.from({ length: count }, (_, s) => ({
        sectionId: uuid(100_000 + s),
        lectureIds: Array.from({ length: perSection }, (_, l) => uuid(s * 1000 + l)),
      }));
    expect(ok(ReorderCurriculumRequestSchema, { sections: sections(50, 0) })).toBe(true);
    expect(ok(ReorderCurriculumRequestSchema, { sections: sections(51, 0) })).toBe(false);
    expect(ok(ReorderCurriculumRequestSchema, { sections: sections(1, 100) })).toBe(true);
    expect(ok(ReorderCurriculumRequestSchema, { sections: sections(1, 101) })).toBe(false);
    expect(ok(ReorderCurriculumRequestSchema, { sections: sections(5, 100) })).toBe(true);
    expect(ok(ReorderCurriculumRequestSchema, { sections: sections(6, 100) })).toBe(false);
  });
});

describe('lifecycle', () => {
  it('submit, archive', () => {
    expect(ok(SubmitCourseRequestSchema, {})).toBe(true);
    expect(ok(SubmitCourseRequestSchema, { note: 'Please check section 2' })).toBe(true);
    expect(ok(SubmitCourseRequestSchema, { note: 'n'.repeat(1001) })).toBe(false);
    expect(ok(SubmitCourseResponseSchema, { revisionId: id, revisionNo: 1 })).toBe(true);
    expect(ok(SubmitCourseResponseSchema, { revisionId: id, revisionNo: 0 })).toBe(false);
    expect(ok(ArchiveCourseRequestSchema, {})).toBe(true);
    expect(ok(ArchiveCourseRequestSchema, { reason: 'r'.repeat(2001) })).toBe(false);
  });

  it('course_not_ready problem carries the issues', () => {
    const problem = {
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      code: 'course_not_ready',
      issues: [
        { code: 'TOO_FEW_LECTURES', sectionId: null, lectureId: null, required: 5, actual: 3 },
        {
          code: 'LECTURE_MEDIA_NOT_READY',
          sectionId: id,
          lectureId: id,
          required: null,
          actual: null,
        },
      ],
    };
    expect(CourseNotReadyProblemSchema.parse(problem)).toEqual(problem);
    expect(ok(CourseNotReadyProblemSchema, { ...problem, issues: [] })).toBe(false);
    expect(
      ok(CourseNotReadyProblemSchema, {
        ...problem,
        issues: [{ ...problem.issues[0], code: 'PRICE_MISSING' }],
      }),
    ).toBe(false);
  });
});

describe('responses', () => {
  const asset = {
    id,
    ownerId: id,
    purpose: 'COURSE_THUMBNAIL',
    status: 'READY',
    originalFilename: 'cover.png',
    sizeBytes: 1000,
    progressPct: null,
    failureCode: null,
    durationSeconds: null,
    width: 1600,
    height: 900,
    renditions: ['w750', 'w480'],
    purged: false,
    createdAt: at,
  };
  const detail = {
    id,
    ownerId: id,
    slug: 'learn-rust',
    slugEditable: false,
    title: 'Learn Rust',
    subtitle: null,
    descriptionMd: null,
    language: 'en',
    level: null,
    categoryId: null,
    thumbnailAssetId: id,
    thumbnail: asset,
    outcomes: ['Write safe code'],
    requirements: [],
    status: 'PUBLISHED',
    badge: 'LIVE_UPDATE_PENDING',
    version: 7,
    locked: true,
    pendingRevision: { id, revisionNo: 2, kind: 'UPDATE', submittedAt: at },
    liveRevision: { id, revisionNo: 1, kind: 'INITIAL', submittedAt: at },
    latestDecision: {
      action: 'APPROVE',
      revisionId: id,
      revisionNo: 1,
      reason: null,
      decidedAt: at,
    },
    readiness: { ready: true, issues: [] },
    hasUnpublishedChanges: true,
    firstPublishedAt: at,
    createdAt: at,
    updatedAt: at,
  };

  it('CourseDetail', () => {
    expect(CourseDetailSchema.parse(detail)).toEqual(detail);
    expect(ok(CourseDetailSchema, { ...detail, badge: 'PUBLISHED' })).toBe(false);
    expect(ok(CourseDetailSchema, { ...detail, readiness: undefined })).toBe(false);
  });

  it('Curriculum', () => {
    const curriculum = {
      courseId: id,
      version: 7,
      locked: false,
      sections: [
        {
          id,
          title: 'Intro',
          objective: null,
          position: 0,
          updatedAt: at,
          lectures: [
            {
              id,
              sectionId: id,
              type: 'ARTICLE',
              title: 'Welcome',
              descriptionMd: null,
              isPreview: true,
              position: 0,
              mediaAssetId: null,
              asset: null,
              articleLength: 120,
              updatedAt: at,
            },
          ],
        },
      ],
      totals: { sectionCount: 1, lectureCount: 1, previewCount: 1, videoSeconds: 0 },
    };
    expect(CurriculumSchema.parse(curriculum)).toEqual(curriculum);
    expect(
      ok(CurriculumSchema, {
        ...curriculum,
        sections: [{ ...curriculum.sections[0], position: -1 }],
      }),
    ).toBe(false);
  });

  it('History', () => {
    const history = {
      items: [
        {
          id,
          action: 'CREATE',
          fromStatus: null,
          toStatus: 'DRAFT',
          revisionId: null,
          revisionNo: null,
          actor: { id, displayName: 'Jane', isModerator: false },
          reason: null,
          occurredAt: at,
        },
        {
          id,
          action: 'REJECT',
          fromStatus: 'IN_REVIEW',
          toStatus: 'REJECTED',
          revisionId: id,
          revisionNo: 1,
          actor: { id: null, displayName: 'Moderator', isModerator: true },
          reason: 'Audio is inaudible in section 2.',
          occurredAt: at,
        },
      ],
    };
    expect(CourseHistoryResponseSchema.parse(history)).toEqual(history);
    expect(
      ok(CourseHistoryResponseSchema, { items: [{ ...history.items[0], action: 'PUBLISH' }] }),
    ).toBe(false);
  });
});
