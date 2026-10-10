import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../errors/error-code';
import { CourseCardSchema, CourseLandingSchema, ThumbnailQuerySchema } from './catalog-public';
import {
  AdminCourseRowSchema,
  RevisionCategorySchema,
  RevisionDiffSchema,
  RevisionLectureDownloadResponseSchema,
  RevisionThumbnailQuerySchema,
  RevisionThumbnailResponseSchema,
} from './course-moderation';
import {
  CourseThumbnailQuerySchema,
  CourseThumbnailResponseSchema,
  LectureDownloadResponseSchema,
  MARKDOWN_CONSTRUCTS,
  MARKDOWN_ISSUE_KINDS,
  MarkdownNotAllowedProblemSchema,
} from './courses';
import { AssetPageSchema, ListAssetsQuerySchema, SignedUrlSchema } from './media';
import { ProblemDetailsSchema } from './problem-details';

/**
 * Phase 2 follow-ups (design §14): every change is additive, so each block checks that the
 * payloads valid before still parse unchanged and that the new members are validated.
 */

const uuid = (n: number) => `0199c9a1-7d2e-7c4a-9b1e-${String(n).padStart(12, '0')}`;
const id = uuid(1);
const at = '2026-10-10T12:00:00.000Z';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('GET /media/assets keyset mode', () => {
  it('defaults to the first page and treats empty values as absent', () => {
    expect(ListAssetsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(ListAssetsQuerySchema.parse({ cursor: '', limit: '', ids: '', ownerId: '' })).toEqual({
      limit: 20,
    });
  });

  it('accepts cursor, limit and an admin ownerId', () => {
    expect(ListAssetsQuerySchema.parse({ cursor: 'abc_-1', limit: '50', ownerId: id })).toEqual({
      cursor: 'abc_-1',
      limit: 50,
      ownerId: id,
    });
    expect(ok(ListAssetsQuerySchema, { limit: '0' })).toBe(false);
    expect(ok(ListAssetsQuerySchema, { limit: '101' })).toBe(false);
    expect(ok(ListAssetsQuerySchema, { cursor: 'not a cursor!' })).toBe(false);
    expect(ok(ListAssetsQuerySchema, { ownerId: 'me' })).toBe(false);
  });

  it('keeps the ids alternative (comma list or repeated), exclusive with cursor', () => {
    expect(ListAssetsQuerySchema.parse({ ids: `${uuid(1)},${uuid(2)}` }).ids).toEqual([
      uuid(1),
      uuid(2),
    ]);
    expect(ListAssetsQuerySchema.parse({ ids: [uuid(1), `${uuid(2)},${uuid(3)}`] }).ids).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
    ]);
    expect(ok(ListAssetsQuerySchema, { ids: `${uuid(1)},${uuid(1)}` })).toBe(false);
    expect(ok(ListAssetsQuerySchema, { ids: Array.from({ length: 51 }, (_, i) => uuid(i)) })).toBe(
      false,
    );
    const both = ListAssetsQuerySchema.safeParse({ ids: uuid(1), cursor: 'abc' });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.path).toEqual(['cursor']);
  });

  it('answers an AssetPage', () => {
    expect(ok(AssetPageSchema, { items: [], nextCursor: null })).toBe(true);
    expect(ok(AssetPageSchema, { items: [], nextCursor: 'abc' })).toBe(true);
    expect(ok(AssetPageSchema, { items: [] })).toBe(false);
  });
});

describe('422 markdown_not_allowed problem', () => {
  const problem = {
    type: 'about:blank',
    title: 'Unprocessable Entity',
    status: 422,
    code: ErrorCode.MarkdownNotAllowed,
    errors: [{ path: 'descriptionMd', message: 'Line 3, column 1: Raw HTML is not allowed' }],
    issues: [
      {
        path: 'descriptionMd',
        line: 3,
        column: 1,
        kind: 'raw_html',
        construct: 'html_block',
        detail: 'Raw HTML is not allowed: <div>',
      },
    ],
  };

  it('extends ProblemDetails with structured issues', () => {
    expect(MarkdownNotAllowedProblemSchema.parse(problem)).toEqual(problem);
    expect(ok(ProblemDetailsSchema, problem)).toBe(true);
  });

  it('validates code, positions and the vocabularies', () => {
    expect(ok(MarkdownNotAllowedProblemSchema, { ...problem, code: 'validation_failed' })).toBe(
      false,
    );
    expect(ok(MarkdownNotAllowedProblemSchema, { ...problem, issues: [] })).toBe(false);
    const issue = problem.issues[0]!;
    for (const bad of [{ line: 0 }, { column: 1.5 }, { kind: 'xss' }, { construct: 'iframe' }]) {
      expect(
        ok(MarkdownNotAllowedProblemSchema, { ...problem, issues: [{ ...issue, ...bad }] }),
      ).toBe(false);
    }
    expect(MARKDOWN_ISSUE_KINDS).toContain('too_complex');
    expect(MARKDOWN_CONSTRUCTS).toContain('literal_autolink');
  });
});

describe('hasThumbnail on cards and landing', () => {
  const card = {
    id,
    slug: 'learn-rust',
    title: 'Learn Rust',
    subtitle: null,
    level: null,
    language: null,
    category: null,
    instructor: null,
    lectureCount: 1,
    videoSeconds: 0,
    publishedAt: at,
  };

  it('is optional and boolean', () => {
    expect(CourseCardSchema.parse(card)).toEqual(card);
    expect(CourseCardSchema.parse({ ...card, hasThumbnail: true }).hasThumbnail).toBe(true);
    expect(ok(CourseCardSchema, { ...card, hasThumbnail: 'yes' })).toBe(false);
    expect(CourseLandingSchema.shape.hasThumbnail.safeParse(undefined).success).toBe(true);
    expect(CourseLandingSchema.shape.hasThumbnail.safeParse(false).success).toBe(true);
    expect(CourseLandingSchema.shape.hasThumbnail.safeParse(null).success).toBe(false);
  });
});

describe('RevisionDiff before/after and removed-lecture sections', () => {
  const diff = {
    baseRevisionId: uuid(2),
    changedFields: ['title', 'outcomes', 'level'],
    sections: { added: [], removed: [], changed: [], moved: [] },
    lectures: {
      added: [],
      removed: [{ id: uuid(11), title: 'Old lecture', type: 'VIDEO' }],
      changed: [],
      moved: [],
    },
  };

  it('old diffs still parse', () => {
    expect(RevisionDiffSchema.parse(diff)).toEqual(diff);
  });

  it('accepts field changes with string, list and null values', () => {
    const full = {
      ...diff,
      fieldChanges: [
        { field: 'title', before: 'Learn Rust', after: 'Learn Rust fast' },
        { field: 'outcomes', before: ['a'], after: ['a', 'b'] },
        { field: 'level', before: null, after: 'EXPERT' },
      ],
      lectures: {
        ...diff.lectures,
        removed: [
          { id: uuid(11), title: 'Old', type: 'VIDEO', sectionId: uuid(4), sectionTitle: 'Intro' },
        ],
      },
    };
    expect(RevisionDiffSchema.parse(full)).toEqual(full);
    expect(
      ok(RevisionDiffSchema, {
        ...diff,
        fieldChanges: [{ field: 'price', before: '1', after: '2' }],
      }),
    ).toBe(false);
    expect(
      ok(RevisionDiffSchema, { ...diff, fieldChanges: [{ field: 'title', before: 1, after: 2 }] }),
    ).toBe(false);
    expect(
      ok(RevisionDiffSchema, {
        ...diff,
        lectures: { ...diff.lectures, removed: [{ ...diff.lectures.removed[0], sectionId: 'x' }] },
      }),
    ).toBe(false);
  });
});

describe('revision snapshot category parent', () => {
  it('is an optional CategoryLeaf', () => {
    const leaf = { id, slug: 'programming', name: 'Programming' };
    expect(RevisionCategorySchema.parse(leaf)).toEqual(leaf);
    const withParent = { ...leaf, parent: { id: uuid(2), slug: 'dev', name: 'Development' } };
    expect(RevisionCategorySchema.parse(withParent)).toEqual(withParent);
    expect(ok(RevisionCategorySchema, { ...leaf, parent: { id: 'x' } })).toBe(false);
  });
});

describe('AdminCourseRow archive actor/reason', () => {
  const row = {
    id,
    slug: 'learn-rust',
    title: 'Learn Rust',
    status: 'ARCHIVED',
    badge: 'ARCHIVED',
    owner: { id, displayName: 'Jane', banned: false },
    pendingRevisionId: null,
    liveRevisionId: id,
    firstPublishedAt: at,
    updatedAt: at,
  };

  it('is optional and nullable', () => {
    expect(AdminCourseRowSchema.parse(row)).toEqual(row);
    const archived = {
      ...row,
      archivedBy: { id: uuid(9), displayName: 'Admin', isModerator: true },
      archiveReason: 'Copyright complaint received.',
    };
    expect(AdminCourseRowSchema.parse(archived)).toEqual(archived);
    expect(ok(AdminCourseRowSchema, { ...row, archivedBy: null, archiveReason: null })).toBe(true);
    expect(ok(AdminCourseRowSchema, { ...row, archivedBy: { id } })).toBe(false);
  });
});

describe('thumbnail and download routes', () => {
  it('reuse the SignedUrl response and the thumbnail variant query', () => {
    for (const schema of [
      CourseThumbnailResponseSchema,
      RevisionThumbnailResponseSchema,
      RevisionLectureDownloadResponseSchema,
      LectureDownloadResponseSchema,
    ]) {
      expect(schema).toBe(SignedUrlSchema);
    }
    expect(CourseThumbnailQuerySchema).toBe(ThumbnailQuerySchema);
    expect(RevisionThumbnailQuerySchema).toBe(ThumbnailQuerySchema);
    expect(CourseThumbnailQuerySchema.parse({})).toEqual({ variant: 'w750' });
    expect(ok(RevisionThumbnailQuerySchema, { variant: 'poster' })).toBe(false);
  });
});
