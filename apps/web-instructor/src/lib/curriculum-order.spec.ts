import { describe, expect, it } from 'vitest';
import { ReorderCurriculumRequestSchema } from '@udemy/contracts';

import { curriculum, IDS } from '@/test/fixtures';

import {
  moveLecture,
  moveSection,
  orderFromCurriculum,
  sameOrder,
  stepLecture,
  stepSection,
  toReorderRequest,
} from './curriculum-order';

const { sectionA: A, sectionB: B, lecture1: l1, lecture2: l2, lecture3: l3 } = IDS;
const start = () => orderFromCurriculum(curriculum());

describe('curriculum order', () => {
  it('reads the order by position', () => {
    expect(start()).toEqual([
      { id: A, lectureIds: [l1, l2] },
      { id: B, lectureIds: [l3] },
    ]);
  });

  it('moves a lecture within a section and across sections', () => {
    expect(moveLecture(start(), l1, A, 1)).toEqual([
      { id: A, lectureIds: [l2, l1] },
      { id: B, lectureIds: [l3] },
    ]);
    expect(moveLecture(start(), l1, B, 0)).toEqual([
      { id: A, lectureIds: [l2] },
      { id: B, lectureIds: [l1, l3] },
    ]);
    // Clamped past the end.
    expect(moveLecture(start(), l1, B, 99)[1]!.lectureIds).toEqual([l3, l1]);
  });

  it('returns the same order for a no-op move', () => {
    const order = start();
    expect(moveLecture(order, l1, A, 0)).toBe(order);
    expect(moveSection(order, A, 0)).toBe(order);
  });

  it('steps lectures across section boundaries (keyboard/button alternative)', () => {
    expect(stepLecture(start(), l2, 1)).toEqual([
      { id: A, lectureIds: [l1] },
      { id: B, lectureIds: [l2, l3] },
    ]);
    expect(stepLecture(start(), l3, -1)).toEqual([
      { id: A, lectureIds: [l1, l2, l3] },
      { id: B, lectureIds: [] },
    ]);
    const order = start();
    expect(stepLecture(order, l1, -1)).toBe(order);
    expect(stepLecture(order, l3, 1)).toBe(order);
  });

  it('steps sections', () => {
    expect(stepSection(start(), B, -1).map((s) => s.id)).toEqual([B, A]);
  });

  it('builds the FULL permutation payload, valid against the contract', () => {
    const payload = toReorderRequest(moveLecture(start(), l1, B, 1));
    expect(payload).toEqual({
      sections: [
        { sectionId: A, lectureIds: [l2] },
        { sectionId: B, lectureIds: [l3, l1] },
      ],
    });
    expect(ReorderCurriculumRequestSchema.safeParse(payload).success).toBe(true);
    expect(sameOrder(start(), start())).toBe(true);
    expect(sameOrder(start(), moveSection(start(), B, 0))).toBe(false);
  });
});
