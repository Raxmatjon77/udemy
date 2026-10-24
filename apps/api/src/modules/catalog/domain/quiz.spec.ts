import { describe, expect, it } from 'vitest';
import {
  LectureTypeMismatch,
  OrderMismatch,
  QuizLimitExceeded,
  QuizOptionsInvalid,
} from './catalog.errors';
import {
  assertCanAddQuizQuestion,
  assertQuizLecture,
  assertValidQuizOptions,
  planQuizQuestionOrder,
  type QuizContent,
  toLearnerQuiz,
  toQuizKey,
} from './quiz';

const quiz: QuizContent = {
  passPct: 80,
  questions: [
    {
      id: 'q-1',
      kind: 'SINGLE_CHOICE',
      promptMd: 'Is TypeScript **typed**?',
      explanationMd: 'It is: the name says so.',
      options: [
        { text: 'Yes', isCorrect: true },
        { text: 'No', isCorrect: false },
      ],
    },
    {
      id: 'q-2',
      kind: 'MULTIPLE_CHOICE',
      promptMd: 'Pick the primitives',
      explanationMd: null,
      options: [
        { text: 'string', isCorrect: true },
        { text: 'Date', isCorrect: false },
        { text: 'number', isCorrect: true },
      ],
    },
  ],
};

/** Every key name anywhere in a JSON tree. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
  }
  return [];
}

describe('quiz rules (Phase 5 D6)', () => {
  it('only QUIZ lectures have questions', () => {
    expect(() => assertQuizLecture('QUIZ')).not.toThrow();
    for (const type of ['VIDEO', 'ARTICLE', 'RESOURCE'] as const) {
      expect(() => assertQuizLecture(type)).toThrow(LectureTypeMismatch);
    }
  });

  it('at most 50 questions', () => {
    expect(() => assertCanAddQuizQuestion(49)).not.toThrow();
    expect(() => assertCanAddQuizQuestion(50)).toThrow(QuizLimitExceeded);
  });

  it('options: 2–6, distinct (case-insensitive), trimmed, no control characters', () => {
    const ok = [
      { text: 'A', isCorrect: true },
      { text: 'B', isCorrect: false },
    ];
    expect(() => assertValidQuizOptions(ok)).not.toThrow();
    // the correct-count rule is readiness, not a write error: no correct option is fine here
    expect(() => assertValidQuizOptions(ok.map((o) => ({ ...o, isCorrect: false })))).not.toThrow();
    const invalid = [
      [{ text: 'Only one', isCorrect: true }],
      Array.from({ length: 7 }, (_, i) => ({ text: `O${i}`, isCorrect: i === 0 })),
      [
        { text: 'Same', isCorrect: true },
        { text: 'same', isCorrect: false },
      ],
      [
        { text: ' padded', isCorrect: true },
        { text: 'B', isCorrect: false },
      ],
      [
        { text: '', isCorrect: true },
        { text: 'B', isCorrect: false },
      ],
      [
        { text: 'tab\there', isCorrect: true },
        { text: 'B', isCorrect: false },
      ],
      [
        { text: 'x'.repeat(301), isCorrect: true },
        { text: 'B', isCorrect: false },
      ],
    ];
    for (const options of invalid) {
      expect(() => assertValidQuizOptions(options)).toThrow(QuizOptionsInvalid);
    }
  });

  it('reorder: an exact permutation, else order_mismatch', () => {
    expect(planQuizQuestionOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([
      { id: 'c', position: 0 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ]);
    for (const requested of [
      ['a', 'b'],
      ['a', 'b', 'c', 'd'],
      ['a', 'a', 'b'],
      ['a', 'b', 'x'],
    ]) {
      expect(() => planQuizQuestionOrder(['a', 'b', 'c'], requested)).toThrow(OrderMismatch);
    }
  });
});

describe('quiz views: the learner view never carries the answer key (D6, Q5)', () => {
  it('toLearnerQuiz keeps questions and option texts in order', () => {
    expect(toLearnerQuiz(quiz)).toEqual({
      passPct: 80,
      questions: [
        {
          id: 'q-1',
          position: 0,
          kind: 'SINGLE_CHOICE',
          promptMd: 'Is TypeScript **typed**?',
          options: [
            { position: 0, text: 'Yes' },
            { position: 1, text: 'No' },
          ],
        },
        {
          id: 'q-2',
          position: 1,
          kind: 'MULTIPLE_CHOICE',
          promptMd: 'Pick the primitives',
          options: [
            { position: 0, text: 'string' },
            { position: 1, text: 'Date' },
            { position: 2, text: 'number' },
          ],
        },
      ],
    });
  });

  it('toLearnerQuiz has no key field and no explanation text anywhere in its JSON', () => {
    const json = JSON.stringify(toLearnerQuiz(quiz));
    const keys = keysOf(JSON.parse(json));
    expect(keys).not.toContain('isCorrect');
    expect(keys).not.toContain('correct');
    expect(keys).not.toContain('explanationMd');
    expect(json).not.toMatch(/isCorrect|correct|explanation/i);
    expect(json).not.toContain('the name says so');
  });

  it('toLearnerQuiz is an allow-list copy: extra fields on the input never pass through', () => {
    const tainted = {
      ...quiz,
      answerKey: 'secret',
      questions: quiz.questions.map((q) => ({
        ...q,
        correct: [0],
        options: q.options.map((o) => ({ ...o, isCorrect: o.isCorrect, secret: true })),
      })),
    };
    const json = JSON.stringify(toLearnerQuiz(tainted));
    expect(json).not.toMatch(/secret|answerKey|isCorrect|"correct"/);
  });

  it('toQuizKey: correct positions ascending and the explanation, per question', () => {
    expect(toQuizKey(quiz)).toEqual({
      passPct: 80,
      questions: [
        {
          id: 'q-1',
          position: 0,
          kind: 'SINGLE_CHOICE',
          correct: [0],
          explanationMd: 'It is: the name says so.',
        },
        { id: 'q-2', position: 1, kind: 'MULTIPLE_CHOICE', correct: [0, 2], explanationMd: null },
      ],
    });
    // the key has no prompt or option texts either: it is for grading, not for display
    expect(JSON.stringify(toQuizKey(quiz))).not.toContain('Pick the primitives');
  });
});
