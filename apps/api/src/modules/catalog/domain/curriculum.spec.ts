import { describe, expect, it } from 'vitest';
import {
  CurriculumLimitExceeded,
  LectureTypeMismatch,
  OrderMismatch,
  PreviewNotAllowed,
} from './catalog.errors';
import {
  assertArticleLecture,
  assertCanAddLecture,
  assertCanAddSection,
  assertCanBePreview,
  mediaPurposeFor,
  planCurriculumOrder,
  planSiblingOrder,
} from './curriculum';

const current = { sectionIds: ['s1', 's2'], lectureIds: ['a', 'b', 'c'] };

describe('planCurriculumOrder (D3 permutation validator)', () => {
  it('accepts a permutation, including cross-section moves, and numbers 0..n-1', () => {
    const plan = planCurriculumOrder(current, [
      { sectionId: 's2', lectureIds: ['c', 'a'] },
      { sectionId: 's1', lectureIds: ['b'] },
    ]);
    expect(plan.sections).toEqual([
      { id: 's2', position: 0 },
      { id: 's1', position: 1 },
    ]);
    expect(plan.lectures).toEqual([
      { id: 'c', sectionId: 's2', position: 0 },
      { id: 'a', sectionId: 's2', position: 1 },
      { id: 'b', sectionId: 's1', position: 0 },
    ]);
  });

  it('allows emptying a section', () => {
    const plan = planCurriculumOrder(current, [
      { sectionId: 's1', lectureIds: [] },
      { sectionId: 's2', lectureIds: ['a', 'b', 'c'] },
    ]);
    expect(plan.lectures.map((l) => l.sectionId)).toEqual(['s2', 's2', 's2']);
  });

  it.each([
    ['a missing section', [{ sectionId: 's1', lectureIds: ['a', 'b', 'c'] }]],
    [
      'an unknown section',
      [
        { sectionId: 's1', lectureIds: ['a', 'b', 'c'] },
        { sectionId: 's2', lectureIds: [] },
        { sectionId: 's3', lectureIds: [] },
      ],
    ],
    [
      'a duplicated section',
      [
        { sectionId: 's1', lectureIds: ['a', 'b'] },
        { sectionId: 's1', lectureIds: ['c'] },
      ],
    ],
    [
      'a missing lecture (stale tab)',
      [
        { sectionId: 's1', lectureIds: ['a'] },
        { sectionId: 's2', lectureIds: ['b'] },
      ],
    ],
    [
      'an unknown lecture',
      [
        { sectionId: 's1', lectureIds: ['a', 'b', 'c'] },
        { sectionId: 's2', lectureIds: ['x'] },
      ],
    ],
    [
      'a duplicated lecture',
      [
        { sectionId: 's1', lectureIds: ['a', 'b'] },
        { sectionId: 's2', lectureIds: ['b', 'c'] },
      ],
    ],
  ])('rejects %s with order_mismatch', (_label, requested) => {
    expect(() => planCurriculumOrder(current, requested)).toThrow(OrderMismatch);
  });

  it('rejects more than 100 lectures in one section', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `l${i}`);
    expect(() =>
      planCurriculumOrder({ sectionIds: ['s1'], lectureIds: ids }, [
        { sectionId: 's1', lectureIds: ids },
      ]),
    ).toThrow(CurriculumLimitExceeded);
  });

  it('sibling order: exact permutation only', () => {
    expect(planSiblingOrder(['x', 'y'], ['y', 'x'])).toEqual([
      { id: 'y', position: 0 },
      { id: 'x', position: 1 },
    ]);
    expect(() => planSiblingOrder(['x', 'y'], ['y'])).toThrow(OrderMismatch);
    expect(() => planSiblingOrder(['x', 'y'], ['y', 'y'])).toThrow(OrderMismatch);
  });
});

describe('curriculum limits and lecture rules', () => {
  it('limits sections (50), lectures per section (100) and per course (500)', () => {
    expect(() => assertCanAddSection(49)).not.toThrow();
    expect(() => assertCanAddSection(50)).toThrow(CurriculumLimitExceeded);
    expect(() => assertCanAddLecture({ inSection: 99, inCourse: 499 })).not.toThrow();
    expect(() => assertCanAddLecture({ inSection: 100, inCourse: 100 })).toThrow(
      CurriculumLimitExceeded,
    );
    expect(() => assertCanAddLecture({ inSection: 0, inCourse: 500 })).toThrow(
      CurriculumLimitExceeded,
    );
  });

  it('maps lecture types to media purposes; articles have none', () => {
    expect(mediaPurposeFor('VIDEO')).toBe('LECTURE_VIDEO');
    expect(mediaPurposeFor('RESOURCE')).toBe('LECTURE_RESOURCE');
    expect(() => mediaPurposeFor('ARTICLE')).toThrow(LectureTypeMismatch);
    expect(() => assertArticleLecture('VIDEO')).toThrow(LectureTypeMismatch);
    expect(() => assertArticleLecture('ARTICLE')).not.toThrow();
  });

  it('previews: VIDEO/ARTICLE only, at most 10 per course', () => {
    expect(() => assertCanBePreview('VIDEO', 9)).not.toThrow();
    expect(() => assertCanBePreview('ARTICLE', 0)).not.toThrow();
    expect(() => assertCanBePreview('RESOURCE', 0)).toThrow(PreviewNotAllowed);
    expect(() => assertCanBePreview('VIDEO', 10)).toThrow(PreviewNotAllowed);
  });
});
