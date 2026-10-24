import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  contentHash,
  referencedAssetIds,
  type SnapshotContent,
  type SnapshotLecture,
} from './revision-snapshot';

const content: SnapshotContent = {
  title: 'Complete TypeScript',
  subtitle: 'From zero to production',
  descriptionMd: '# Hello\n\nA description.',
  language: 'en',
  level: 'BEGINNER',
  categoryId: 'cat-1',
  thumbnailAssetId: 'asset-t',
  outcomes: ['One', 'Two'],
  requirements: ['Node'],
  sections: [
    {
      id: 's1',
      title: 'Intro',
      objective: null,
      lectures: [
        {
          id: 'l1',
          type: 'VIDEO',
          title: 'Welcome',
          descriptionMd: null,
          isPreview: true,
          mediaAssetId: 'asset-v',
          articleBodyMd: null,
          quiz: null,
        },
        {
          id: 'l2',
          type: 'ARTICLE',
          title: 'Read me',
          descriptionMd: 'x',
          isPreview: false,
          mediaAssetId: null,
          articleBodyMd: 'Body  \n',
          quiz: null,
        },
      ],
    },
    { id: 's2', title: 'Next', objective: 'Go', lectures: [] },
  ],
};

describe('canonical snapshot hash', () => {
  it('canonical JSON sorts keys and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, 1], c: { y: null, x: 'é' } })).toBe(
      '{"a":[2,1],"b":1,"c":{"x":"é","y":null}}',
    );
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
  });

  it('is stable: equal content gives the same 32-byte hash, whatever the key order', () => {
    const shuffled = JSON.parse(JSON.stringify(content)) as SnapshotContent;
    const reordered: SnapshotContent = {
      sections: shuffled.sections,
      requirements: shuffled.requirements,
      outcomes: shuffled.outcomes,
      thumbnailAssetId: shuffled.thumbnailAssetId,
      categoryId: shuffled.categoryId,
      level: shuffled.level,
      language: shuffled.language,
      descriptionMd: shuffled.descriptionMd,
      subtitle: shuffled.subtitle,
      title: shuffled.title,
    };
    expect(contentHash(content)).toHaveLength(32);
    expect(contentHash(reordered).equals(contentHash(content))).toBe(true);
    // pinned: the canonical form is part of the stored data (changing it needs a version bump)
    expect(contentHash(content).toString('hex')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reordering lectures, sections or bullets changes the hash', () => {
    const base = contentHash(content).toString('hex');
    const [s1, s2] = content.sections;
    if (s1 === undefined || s2 === undefined) throw new Error('fixture');
    const lecturesSwapped = {
      ...content,
      sections: [{ ...s1, lectures: [...s1.lectures].reverse() }, s2],
    };
    const sectionsSwapped = { ...content, sections: [s2, s1] };
    const outcomesSwapped = { ...content, outcomes: ['Two', 'One'] };
    for (const changed of [lecturesSwapped, sectionsSwapped, outcomesSwapped]) {
      expect(contentHash(changed).toString('hex')).not.toBe(base);
    }
  });

  it('any content change (whitespace in a body, a media swap, null vs empty) changes the hash', () => {
    const base = contentHash(content).toString('hex');
    const variants: SnapshotContent[] = [
      { ...content, title: 'Complete TypeScript!' },
      { ...content, subtitle: null },
      { ...content, thumbnailAssetId: 'asset-t2' },
      { ...content, requirements: [] },
    ];
    for (const v of variants) expect(contentHash(v).toString('hex')).not.toBe(base);
  });

  it('lists every referenced asset once, ascending', () => {
    expect(referencedAssetIds(content)).toEqual(['asset-t', 'asset-v']);
  });
});

describe('canonical snapshot hash: QUIZ lectures (Phase 5 D6)', () => {
  const quizLecture: SnapshotLecture = {
    id: 'l3',
    type: 'QUIZ',
    title: 'Check yourself',
    descriptionMd: null,
    isPreview: false,
    mediaAssetId: null,
    articleBodyMd: null,
    quiz: {
      passPct: 70,
      questions: [
        {
          id: 'q1',
          kind: 'SINGLE_CHOICE',
          promptMd: 'Pick one',
          explanationMd: 'Because.',
          options: [
            { text: 'Right', isCorrect: true },
            { text: 'Wrong', isCorrect: false },
          ],
        },
      ],
    },
  };
  const withQuiz = (lecture: SnapshotLecture): SnapshotContent => {
    const [s1, s2] = content.sections;
    if (s1 === undefined || s2 === undefined) throw new Error('fixture');
    return { ...content, sections: [s1, { ...s2, lectures: [lecture] }] };
  };

  it('non-QUIZ lectures keep the pre-Phase-5 canonical form (old content_hash values match)', () => {
    // The exact canonical JSON of the fixture as P2 hashed it: no `quiz` member anywhere.
    const legacy = canonicalJson({
      v: 1,
      title: content.title,
      subtitle: content.subtitle,
      descriptionMd: content.descriptionMd,
      language: content.language,
      level: content.level,
      categoryId: content.categoryId,
      thumbnailAssetId: content.thumbnailAssetId,
      outcomes: [...content.outcomes],
      requirements: [...content.requirements],
      sections: content.sections.map((s) => ({
        id: s.id,
        title: s.title,
        objective: s.objective,
        lectures: s.lectures.map((l) => ({
          id: l.id,
          type: l.type,
          title: l.title,
          descriptionMd: l.descriptionMd,
          isPreview: l.isPreview,
          mediaAssetId: l.mediaAssetId,
          articleBodyMd: l.articleBodyMd,
        })),
      })),
    });
    const expected = createHash('sha256').update(legacy, 'utf8').digest('hex');
    expect(contentHash(content).toString('hex')).toBe(expected);
  });

  it('every quiz edit changes the hash: pass mark, prompt, explanation, option text, key, order', () => {
    const base = contentHash(withQuiz(quizLecture)).toString('hex');
    const quiz = quizLecture.quiz;
    const question = quiz?.questions[0];
    if (quiz === null || question === undefined) throw new Error('fixture');
    const [right, wrong] = question.options;
    if (right === undefined || wrong === undefined) throw new Error('fixture');
    const variants: SnapshotLecture['quiz'][] = [
      { ...quiz, passPct: 71 },
      { ...quiz, questions: [{ ...question, promptMd: 'Pick one!' }] },
      { ...quiz, questions: [{ ...question, explanationMd: null }] },
      { ...quiz, questions: [{ ...question, kind: 'MULTIPLE_CHOICE' }] },
      { ...quiz, questions: [{ ...question, options: [{ ...right, text: 'Correct' }, wrong] }] },
      {
        ...quiz,
        questions: [
          {
            ...question,
            options: [
              { ...right, isCorrect: false },
              { ...wrong, isCorrect: true },
            ],
          },
        ],
      },
      { ...quiz, questions: [{ ...question, options: [wrong, right] }] },
      { ...quiz, questions: [] },
    ];
    for (const variant of variants) {
      expect(contentHash(withQuiz({ ...quizLecture, quiz: variant })).toString('hex')).not.toBe(
        base,
      );
    }
    // equal content, equal hash
    expect(contentHash(withQuiz(structuredClone(quizLecture))).toString('hex')).toBe(base);
  });

  it('a quiz references no media asset', () => {
    expect(referencedAssetIds(withQuiz(quizLecture))).toEqual(['asset-t', 'asset-v']);
  });
});
