import { describe, expect, it } from 'vitest';
import { plainTextLength } from './markdown';
import {
  evaluateReadiness,
  type ReadinessAsset,
  type ReadinessInput,
  readyVideoSeconds,
} from './readiness';

const thresholds = { minLectures: 5, minVideoSeconds: 1800 };
const ready: ReadinessAsset = { status: 'READY', purged: false, durationSeconds: 600 };

function video(id: string, asset = ready) {
  return {
    id,
    type: 'VIDEO' as const,
    mediaAssetId: `asset-${id}`,
    asset,
    articlePlainLength: null,
  };
}

function readyInput(): ReadinessInput {
  return {
    subtitle: 'A subtitle that is long enough',
    descriptionPlainLength: 250,
    language: 'en',
    level: 'BEGINNER',
    categoryId: 'cat',
    categoryActive: true,
    thumbnailAssetId: 'thumb',
    thumbnail: { status: 'READY', purged: false, durationSeconds: null },
    outcomeCount: 4,
    sections: [
      { id: 's1', lectures: [video('l1'), video('l2'), video('l3')] },
      {
        id: 's2',
        lectures: [
          {
            id: 'l4',
            type: 'ARTICLE',
            mediaAssetId: null,
            asset: null,
            articlePlainLength: 50,
          },
          {
            id: 'l5',
            type: 'RESOURCE',
            mediaAssetId: 'asset-l5',
            asset: { status: 'READY', purged: false, durationSeconds: null },
            articlePlainLength: null,
          },
        ],
      },
    ],
  };
}

describe('evaluateReadiness (invariant 6)', () => {
  it('a complete course is ready', () => {
    expect(evaluateReadiness(readyInput(), thresholds)).toEqual({ ready: true, issues: [] });
  });

  it('a fresh draft reports every issue at once, in a stable order', () => {
    const result = evaluateReadiness(
      {
        subtitle: null,
        descriptionPlainLength: null,
        language: null,
        level: null,
        categoryId: null,
        categoryActive: null,
        thumbnailAssetId: null,
        thumbnail: null,
        outcomeCount: 1,
        sections: [],
      },
      thresholds,
    );
    expect(result.ready).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual([
      'SUBTITLE_MISSING',
      'DESCRIPTION_TOO_SHORT',
      'LANGUAGE_MISSING',
      'LEVEL_MISSING',
      'CATEGORY_MISSING',
      'THUMBNAIL_MISSING',
      'TOO_FEW_OUTCOMES',
      'NO_SECTIONS',
      'TOO_FEW_LECTURES',
      'NOT_ENOUGH_VIDEO',
    ]);
    expect(result.issues.find((i) => i.code === 'TOO_FEW_OUTCOMES')).toEqual({
      code: 'TOO_FEW_OUTCOMES',
      sectionId: null,
      lectureId: null,
      required: 4,
      actual: 1,
    });
    expect(result.issues.find((i) => i.code === 'DESCRIPTION_TOO_SHORT')?.actual).toBe(0);
  });

  it('points at the offending section and lectures', () => {
    const input = readyInput();
    const result = evaluateReadiness(
      {
        ...input,
        categoryActive: false,
        thumbnail: { status: 'PROCESSING', purged: false, durationSeconds: null },
        sections: [
          {
            id: 's1',
            lectures: [
              video('l1'),
              { ...video('l2'), mediaAssetId: null, asset: null },
              video('l3', { status: 'PROCESSING', purged: false, durationSeconds: null }),
              video('l6', { ...ready, purged: true }),
            ],
          },
          { id: 'empty', lectures: [] },
          {
            id: 's2',
            lectures: [
              {
                id: 'l4',
                type: 'ARTICLE',
                mediaAssetId: null,
                asset: null,
                articlePlainLength: 12,
              },
            ],
          },
        ],
      },
      thresholds,
    );
    expect(result.issues).toEqual([
      { code: 'CATEGORY_INACTIVE', sectionId: null, lectureId: null, required: null, actual: null },
      {
        code: 'THUMBNAIL_NOT_READY',
        sectionId: null,
        lectureId: null,
        required: null,
        actual: null,
      },
      { code: 'SECTION_EMPTY', sectionId: 'empty', lectureId: null, required: null, actual: null },
      { code: 'NOT_ENOUGH_VIDEO', sectionId: null, lectureId: null, required: 1800, actual: 600 },
      {
        code: 'LECTURE_MEDIA_MISSING',
        sectionId: 's1',
        lectureId: 'l2',
        required: null,
        actual: null,
      },
      {
        code: 'LECTURE_MEDIA_NOT_READY',
        sectionId: 's1',
        lectureId: 'l3',
        required: null,
        actual: null,
      },
      {
        code: 'LECTURE_MEDIA_NOT_READY',
        sectionId: 's1',
        lectureId: 'l6',
        required: null,
        actual: null,
      },
      { code: 'ARTICLE_TOO_SHORT', sectionId: 's2', lectureId: 'l4', required: 50, actual: 12 },
    ]);
  });

  it('uses the configurable thresholds (dev/e2e: 1 lecture, 0 seconds)', () => {
    const input = readyInput();
    const small = {
      ...input,
      sections: [{ id: 's1', lectures: [video('l1', { ...ready, durationSeconds: 5 })] }],
    };
    expect(evaluateReadiness(small, thresholds).issues.map((i) => i.code)).toEqual([
      'TOO_FEW_LECTURES',
      'NOT_ENOUGH_VIDEO',
    ]);
    expect(evaluateReadiness(small, { minLectures: 1, minVideoSeconds: 0 }).ready).toBe(true);
  });

  it('a language outside the allowlist counts as missing', () => {
    const issues = evaluateReadiness({ ...readyInput(), language: 'xx' }, thresholds).issues;
    expect(issues.map((i) => i.code)).toEqual(['LANGUAGE_MISSING']);
  });

  it('counts only READY, unpurged video seconds', () => {
    expect(readyVideoSeconds(readyInput().sections)).toBe(1800);
  });
});

describe('evaluateReadiness: QUIZ lectures (Phase 5 design §5)', () => {
  type Kind = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE';
  const question = (kind: Kind, correct: readonly boolean[]) => ({
    kind,
    options: correct.map((isCorrect) => ({ isCorrect })),
  });
  function withQuiz(quiz: { questions: ReturnType<typeof question>[] } | null): ReadinessInput {
    const input = readyInput();
    const [s1, s2] = input.sections;
    if (s1 === undefined || s2 === undefined) throw new Error('fixture');
    const quizLecture = {
      id: 'q1',
      type: 'QUIZ' as const,
      mediaAssetId: null,
      asset: null,
      articlePlainLength: null,
      quiz,
    };
    return { ...input, sections: [s1, { ...s2, lectures: [...s2.lectures, quizLecture] }] };
  }

  it('a complete quiz is ready and never needs media (no LECTURE_MEDIA_MISSING)', () => {
    const result = evaluateReadiness(
      withQuiz({
        questions: [
          question('SINGLE_CHOICE', [false, true]),
          question('MULTIPLE_CHOICE', [true, true, false]),
        ],
      }),
      thresholds,
    );
    expect(result).toEqual({ ready: true, issues: [] });
  });

  it('QUIZ_EMPTY without questions (or without quiz content)', () => {
    for (const quiz of [{ questions: [] }, null]) {
      expect(evaluateReadiness(withQuiz(quiz), thresholds).issues).toEqual([
        { code: 'QUIZ_EMPTY', sectionId: 's2', lectureId: 'q1', required: 1, actual: 0 },
      ]);
    }
  });

  it('ONE QUIZ_QUESTION_INVALID per lecture, `actual` = the number of broken questions', () => {
    const result = evaluateReadiness(
      withQuiz({
        questions: [
          question('SINGLE_CHOICE', [true, true]), // SINGLE with two correct
          question('SINGLE_CHOICE', [false, false]), // no correct option
          question('MULTIPLE_CHOICE', [false, false, false]), // MULTIPLE needs one correct
          question('MULTIPLE_CHOICE', [true]), // one option only
          question('SINGLE_CHOICE', []), // no options yet
          question('SINGLE_CHOICE', [true, false]), // fine
        ],
      }),
      thresholds,
    );
    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([
      {
        code: 'QUIZ_QUESTION_INVALID',
        sectionId: 's2',
        lectureId: 'q1',
        required: null,
        actual: 5,
      },
    ]);
  });

  it('a quiz counts as a lecture, not as video', () => {
    const input = withQuiz({ questions: [question('SINGLE_CHOICE', [true, false])] });
    expect(readyVideoSeconds(input.sections)).toBe(1800);
    const fewer = evaluateReadiness(input, { minLectures: 7, minVideoSeconds: 0 });
    expect(fewer.issues).toEqual([
      expect.objectContaining({ code: 'TOO_FEW_LECTURES', required: 7, actual: 6 }),
    ]);
  });
});

describe('plainTextLength (readiness character counts)', () => {
  it('ignores markdown syntax and link destinations, counts code points', () => {
    expect(plainTextLength('# Title\n\n**bold** and _em_')).toBe('Title bold and em'.length);
    expect(plainTextLength('See [the docs](https://example.com/a/very/long/path).')).toBe(
      'See the docs.'.length,
    );
    expect(plainTextLength('- one\n- two\n1. three')).toBe('one two three'.length);
    expect(plainTextLength('```ts\nconst x = 1;\n```')).toBe('const x = 1;'.length);
    expect(plainTextLength('> quoted\n\n---\n\n[ref]: https://x.test')).toBe('quoted'.length);
    expect(plainTextLength('😀😀')).toBe(2);
    expect(plainTextLength('   \n\n  ')).toBe(0);
  });

  it('is exact where a regex stripper was not (same parse as the renderer)', () => {
    // Emphasis markers that do not form emphasis are visible text.
    expect(plainTextLength('2 * 3 * 4')).toBe('2 * 3 * 4'.length);
    expect(plainTextLength('snake_case_name')).toBe('snake_case_name'.length);
    // Inline code keeps its content; escapes render as the escaped character.
    expect(plainTextLength('Use `a|b` and \\*')).toBe('Use a|b and *'.length);
  });

  it('counts markdown that trips the cost guard as 0 instead of throwing', () => {
    // Write-path validation rejects this (too_deeply_nested), so it only exists in legacy data.
    expect(plainTextLength(`${'> '.repeat(40)}deep`)).toBe(0);
  });
});
