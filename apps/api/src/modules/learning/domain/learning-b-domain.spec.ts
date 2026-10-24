import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { assertMarkdownAllowed, assertNoteCapacity, assertNotePosition } from './notes';
import {
  buildQuizResult,
  gradeAttempt,
  normalizeAnswers,
  type QuizQuestionShape,
  scorePctOf,
} from './quiz-grading';

const Q1 = '01900000-0000-7000-8000-0000000c0001';
const Q2 = '01900000-0000-7000-8000-0000000c0002';
const QUESTIONS = [
  { questionId: Q1, position: 0 },
  { questionId: Q2, position: 1 },
];
const SHAPES = new Map<string, QuizQuestionShape>([
  [Q1, { id: Q1, kind: 'SINGLE_CHOICE', optionCount: 3 }],
  [Q2, { id: Q2, kind: 'MULTIPLE_CHOICE', optionCount: 4 }],
]);
const KEY = {
  passPct: 50,
  questions: [
    { id: Q1, kind: 'SINGLE_CHOICE' as const, correct: [2], explanationMd: 'Because' },
    { id: Q2, kind: 'MULTIPLE_CHOICE' as const, correct: [0, 3], explanationMd: null },
  ],
};

describe('quiz grading', () => {
  it('normalizes answers (sorted, case-insensitive ids, empty = unanswered)', () => {
    const result = normalizeAnswers(QUESTIONS, SHAPES, [
      { questionId: Q2.toUpperCase(), optionPositions: [3, 0] },
      { questionId: Q1, optionPositions: [] },
    ]);
    expect([...result]).toEqual([[Q2, [0, 3]]]);
  });

  it.each([
    [
      'an unknown question',
      [{ questionId: '01900000-0000-7000-8000-0000000c0009', optionPositions: [0] }],
    ],
    ['a position out of range', [{ questionId: Q1, optionPositions: [3] }]],
    ['two selections on a single-choice question', [{ questionId: Q1, optionPositions: [0, 1] }]],
    [
      'a question answered twice',
      [
        { questionId: Q1, optionPositions: [0] },
        { questionId: Q1, optionPositions: [1] },
      ],
    ],
    ['duplicate positions', [{ questionId: Q2, optionPositions: [1, 1] }]],
  ])('422 quiz_answers_invalid for %s', (_label, answers) => {
    expect(() => normalizeAnswers(QUESTIONS, SHAPES, answers)).toThrowError(
      expect.objectContaining({ code: ErrorCode.QuizAnswersInvalid }),
    );
  });

  it('a question is correct iff the selected set equals the correct set (all-or-nothing)', () => {
    const partial = gradeAttempt(
      QUESTIONS,
      new Map([
        [Q1, [2]],
        [Q2, [0]],
      ]),
      KEY,
      50,
    );
    expect(partial).toEqual({
      questions: [
        { questionId: Q1, isCorrect: true },
        { questionId: Q2, isCorrect: false },
      ],
      correctCount: 1,
      scorePct: 50,
      passed: true,
    });
    const none = gradeAttempt(QUESTIONS, new Map(), KEY, 50);
    expect(none).toMatchObject({ correctCount: 0, scorePct: 0, passed: false });
  });

  it('score rounds half away from zero, like the generated column', () => {
    expect(scorePctOf(2, 3)).toBe(67);
    expect(scorePctOf(1, 3)).toBe(33);
    expect(scorePctOf(1, 8)).toBe(13);
    expect(scorePctOf(7, 10)).toBe(70);
  });

  it('a key unknown to the attempt question is a data bug, never "wrong"', () => {
    expect(() =>
      gradeAttempt(QUESTIONS, new Map(), { passPct: 50, questions: [KEY.questions[0]!] }, 50),
    ).toThrow(/answer key/);
  });

  it('buildQuizResult ignores a key handed in for a FAILED attempt (reveal policy)', () => {
    const attempt = {
      id: '01900000-0000-7000-8000-0000000a0001',
      courseId: '01900000-0000-7000-8000-00000000c001',
      lectureId: '01900000-0000-7000-8000-00000000f004',
      passPct: 70,
      questionCount: 2,
      correctCount: 1,
      scorePct: 50,
      passed: false,
      submittedAt: new Date('2026-10-24T12:00:00Z'),
    };
    const graded = [
      { questionId: Q1, position: 0, isCorrect: true },
      { questionId: Q2, position: 1, isCorrect: false },
    ];
    const failed = buildQuizResult(attempt, graded, new Map([[Q1, [2]]]), KEY);
    expect(failed.revealed).toBe(false);
    expect(failed.questions.map((q) => [q.correctOptions, q.explanationMd])).toEqual([
      [null, null],
      [null, null],
    ]);
    const passed = buildQuizResult({ ...attempt, passed: true }, graded, new Map(), KEY);
    expect(passed.revealed).toBe(true);
    expect(passed.questions.map((q) => [q.correctOptions, q.explanationMd])).toEqual([
      [[2], 'Because'],
      [[0, 3], null],
    ]);
  });
});

describe('notes rules', () => {
  const video = { type: 'VIDEO' as const, durationSeconds: 60 };
  it('a timestamp only on a video within its duration', () => {
    expect(() => assertNotePosition(video, 60)).not.toThrow();
    expect(() => assertNotePosition(video, undefined)).not.toThrow();
    expect(() => assertNotePosition(null, null)).not.toThrow();
    for (const [lecture, position] of [
      [video, 61],
      [video, -1],
      [video, 1.5],
      [{ type: 'ARTICLE' as const, durationSeconds: null }, 0],
      [null, 0],
    ] as const) {
      expect(() => assertNotePosition(lecture, position)).toThrowError(
        expect.objectContaining({ code: ErrorCode.ValidationFailed }),
      );
    }
  });

  it('the 500-notes cap', () => {
    expect(() => assertNoteCapacity(499)).not.toThrow();
    expect(() => assertNoteCapacity(500)).toThrowError(
      expect.objectContaining({ code: ErrorCode.NoteLimitExceeded }),
    );
  });

  it('markdown: plain markdown and safe links pass; HTML and images do not', () => {
    expect(() => assertMarkdownAllowed('bodyMd', '**bold** [x](https://e.test)')).not.toThrow();
    expect(() => assertMarkdownAllowed('bodyMd', '<img src=x>')).toThrowError(
      expect.objectContaining({ code: ErrorCode.MarkdownNotAllowed }),
    );
  });
});
