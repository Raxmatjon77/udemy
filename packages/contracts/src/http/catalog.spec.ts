import { describe, expect, it } from 'vitest';
import {
  ArticleBodySchema,
  CategoryNameSchema,
  COURSE_LANGUAGE_LABELS,
  COURSE_LANGUAGES,
  COURSE_LEVEL_LABELS,
  COURSE_LEVELS,
  COURSE_READINESS_RULES,
  COURSE_SUBMISSION_DEFAULTS,
  CourseBulletListSchema,
  CourseDescriptionSchema,
  CourseSubtitleSchema,
  CourseTitleSchema,
  CURRICULUM_LIMITS,
  LECTURE_MEDIA_PURPOSE,
  LectureDescriptionSchema,
  LectureTitleSchema,
  ModerationReasonSchema,
  SectionObjectiveSchema,
  SectionTitleSchema,
  SubmitNoteSchema,
} from './catalog';
import { codePointLength, SlugSchema } from './fields';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('catalog constants', () => {
  it('levels and languages', () => {
    expect(COURSE_LEVELS).toEqual(['BEGINNER', 'INTERMEDIATE', 'EXPERT', 'ALL_LEVELS']);
    expect(Object.keys(COURSE_LEVEL_LABELS).sort()).toEqual([...COURSE_LEVELS].sort());
    expect(Object.keys(COURSE_LANGUAGE_LABELS).sort()).toEqual([...COURSE_LANGUAGES].sort());
    expect(new Set(COURSE_LANGUAGES).size).toBe(COURSE_LANGUAGES.length);
    for (const tag of COURSE_LANGUAGES) expect(tag).toMatch(/^[a-z]{2,3}(-[A-Z]{2})?$/);
    expect(COURSE_LANGUAGES).toEqual(expect.arrayContaining(['en', 'ru', 'uz']));
  });

  it('submission thresholds default to 5 lectures / 30 minutes (§13 Q6)', () => {
    expect(COURSE_SUBMISSION_DEFAULTS).toEqual({ minLectures: 5, minVideoSeconds: 1800 });
    expect(COURSE_READINESS_RULES).toEqual({
      minDescriptionChars: 200,
      minOutcomes: 4,
      minArticleChars: 50,
    });
    expect(CURRICULUM_LIMITS).toEqual({
      maxSectionsPerCourse: 50,
      maxLecturesPerSection: 100,
      maxLecturesPerCourse: 500,
      maxPreviewLectures: 10,
      maxBulletsPerKind: 10,
    });
  });

  it('maps lecture types to media purposes', () => {
    expect(LECTURE_MEDIA_PURPOSE).toEqual({
      VIDEO: 'LECTURE_VIDEO',
      RESOURCE: 'LECTURE_RESOURCE',
      ARTICLE: null,
      // Phase 5: quizzes have no media
      QUIZ: null,
    });
  });
});

describe('catalog field lengths (= DB CHECKs)', () => {
  it.each([
    ['course title', CourseTitleSchema, 5, 60],
    ['course subtitle', CourseSubtitleSchema, 10, 120],
    ['section title', SectionTitleSchema, 1, 80],
    ['section objective', SectionObjectiveSchema, 1, 200],
    ['lecture title', LectureTitleSchema, 1, 80],
    ['category name', CategoryNameSchema, 2, 60],
  ] as const)('%s: length bounds, trimmed, single line', (_name, schema, min, max) => {
    expect(ok(schema, 'a'.repeat(min))).toBe(true);
    expect(ok(schema, 'a'.repeat(max))).toBe(true);
    expect(ok(schema, 'a'.repeat(max + 1))).toBe(false);
    if (min > 1) expect(ok(schema, 'a'.repeat(min - 1))).toBe(false);
    expect(ok(schema, ` ${'a'.repeat(min - 1)} `)).toBe(false);
    expect(ok(schema, '')).toBe(false);
    expect(ok(schema, `${'a'.repeat(min)}\nb`)).toBe(false);
    expect(schema.parse(`  ${'a'.repeat(min)}  `)).toBe('a'.repeat(min));
  });

  it('counts the minimum in characters, like char_length', () => {
    expect(codePointLength('😀😀😀')).toBe(3);
    expect('😀😀😀'.length).toBe(6);
    expect(ok(CourseTitleSchema, '😀😀😀')).toBe(false);
    expect(ok(CourseTitleSchema, '😀😀😀😀😀')).toBe(true);
  });

  it('markdown fields keep whitespace, allow line breaks and bound the length', () => {
    expect(CourseDescriptionSchema.parse('# Intro  \n\n- one\n\t- two  ')).toBe(
      '# Intro  \n\n- one\n\t- two  ',
    );
    expect(ok(CourseDescriptionSchema, 'd'.repeat(20_000))).toBe(true);
    expect(ok(CourseDescriptionSchema, 'd'.repeat(20_001))).toBe(false);
    expect(ok(CourseDescriptionSchema, '')).toBe(false);
    expect(ok(CourseDescriptionSchema, 'bell\u0007')).toBe(false);
    expect(ok(LectureDescriptionSchema, 'd'.repeat(2000))).toBe(true);
    expect(ok(LectureDescriptionSchema, 'd'.repeat(2001))).toBe(false);
    expect(ok(ArticleBodySchema, '')).toBe(true);
    expect(ok(ArticleBodySchema, 'a'.repeat(100_000))).toBe(true);
    expect(ok(ArticleBodySchema, 'a'.repeat(100_001))).toBe(false);
  });

  it('bullets: at most 10 lines of 1–160', () => {
    expect(ok(CourseBulletListSchema, [])).toBe(true);
    expect(
      ok(
        CourseBulletListSchema,
        Array.from({ length: 10 }, () => 'b'.repeat(160)),
      ),
    ).toBe(true);
    expect(
      ok(
        CourseBulletListSchema,
        Array.from({ length: 11 }, () => 'b'),
      ),
    ).toBe(false);
    expect(ok(CourseBulletListSchema, ['b'.repeat(161)])).toBe(false);
    expect(ok(CourseBulletListSchema, ['  '])).toBe(false);
  });

  it('notes and moderation reasons', () => {
    expect(ok(SubmitNoteSchema, 'n'.repeat(1000))).toBe(true);
    expect(ok(SubmitNoteSchema, 'n'.repeat(1001))).toBe(false);
    expect(ok(SubmitNoteSchema, '')).toBe(false);
    expect(ok(ModerationReasonSchema, 'r'.repeat(10))).toBe(true);
    expect(ok(ModerationReasonSchema, 'r'.repeat(2000))).toBe(true);
    expect(ok(ModerationReasonSchema, 'r'.repeat(9))).toBe(false);
    expect(ok(ModerationReasonSchema, 'r'.repeat(2001))).toBe(false);
    expect(ok(ModerationReasonSchema, 'line one\nline two')).toBe(true);
  });
});

describe('SlugSchema', () => {
  it('accepts kebab-case up to 60 and normalises case', () => {
    expect(SlugSchema.parse(' Complete-TypeScript-2 ')).toBe('complete-typescript-2');
    expect(ok(SlugSchema, 'a')).toBe(true);
    expect(ok(SlugSchema, 'a'.repeat(60))).toBe(true);
    expect(ok(SlugSchema, 'a'.repeat(61))).toBe(false);
  });

  it('rejects anything outside ^[a-z0-9]+(-[a-z0-9]+)*$', () => {
    for (const slug of ['', '-a', 'a-', 'a--b', 'a_b', 'a b', 'ünï', 'a/b', '..']) {
      expect(ok(SlugSchema, slug), slug).toBe(false);
    }
  });
});
