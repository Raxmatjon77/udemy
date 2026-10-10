import {
  ReorderCurriculumRequestSchema,
  type Curriculum,
  type ReorderCurriculumRequest,
} from '@udemy/contracts';

/**
 * The curriculum order as the builder edits it (design D3): sections in order, each with its
 * lecture ids in order. Pure functions only; the drag-and-drop list and the "move" buttons both
 * produce a new order, and `toReorderRequest` turns it into the FULL-permutation payload of
 * `PUT /courses/:id/curriculum/order`.
 */
export interface OrderSection {
  id: string;
  lectureIds: string[];
}
export type CurriculumOrder = OrderSection[];

export function orderFromCurriculum(curriculum: Curriculum): CurriculumOrder {
  return [...curriculum.sections]
    .sort((a, b) => a.position - b.position)
    .map((section) => ({
      id: section.id,
      lectureIds: [...section.lectures]
        .sort((a, b) => a.position - b.position)
        .map((lecture) => lecture.id),
    }));
}

export function sameOrder(a: CurriculumOrder, b: CurriculumOrder): boolean {
  return (
    a.length === b.length &&
    a.every(
      (section, i) =>
        section.id === b[i]?.id &&
        section.lectureIds.length === b[i]!.lectureIds.length &&
        section.lectureIds.every((id, j) => id === b[i]?.lectureIds[j]),
    )
  );
}

export function findLecture(
  order: CurriculumOrder,
  lectureId: string,
): { sectionIndex: number; index: number } | null {
  for (let sectionIndex = 0; sectionIndex < order.length; sectionIndex += 1) {
    const index = order[sectionIndex]!.lectureIds.indexOf(lectureId);
    if (index !== -1) return { sectionIndex, index };
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Moves a section to `toIndex` (clamped). Returns the same array when nothing changes. */
export function moveSection(order: CurriculumOrder, sectionId: string, toIndex: number): CurriculumOrder {
  const from = order.findIndex((section) => section.id === sectionId);
  if (from === -1) return order;
  const to = clamp(toIndex, 0, order.length - 1);
  if (from === to) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Moves a lecture into `toSectionId` at `toIndex` (clamped; the index is in the target list
 * AFTER the lecture was taken out). Works within one section and across sections.
 */
export function moveLecture(
  order: CurriculumOrder,
  lectureId: string,
  toSectionId: string,
  toIndex: number,
): CurriculumOrder {
  const from = findLecture(order, lectureId);
  const target = order.findIndex((section) => section.id === toSectionId);
  if (!from || target === -1) return order;
  const next = order.map((section) => ({ ...section, lectureIds: [...section.lectureIds] }));
  next[from.sectionIndex]!.lectureIds.splice(from.index, 1);
  const list = next[target]!.lectureIds;
  const to = clamp(toIndex, 0, list.length);
  if (from.sectionIndex === target && from.index === to) return order;
  list.splice(to, 0, lectureId);
  return next;
}

/**
 * One step up (-1) or down (+1), the keyboard/button alternative to dragging: past the start
 * or end of a section the lecture moves to the end of the previous / start of the next one.
 */
export function stepLecture(order: CurriculumOrder, lectureId: string, delta: -1 | 1): CurriculumOrder {
  const from = findLecture(order, lectureId);
  if (!from) return order;
  const section = order[from.sectionIndex]!;
  const index = from.index + delta;
  if (index >= 0 && index < section.lectureIds.length) {
    return moveLecture(order, lectureId, section.id, index);
  }
  const neighbour = order[from.sectionIndex + delta];
  if (!neighbour) return order;
  return moveLecture(order, lectureId, neighbour.id, delta < 0 ? neighbour.lectureIds.length : 0);
}

export function stepSection(order: CurriculumOrder, sectionId: string, delta: -1 | 1): CurriculumOrder {
  const from = order.findIndex((section) => section.id === sectionId);
  return from === -1 ? order : moveSection(order, sectionId, from + delta);
}

/** The full-permutation payload, validated against the contracts schema. */
export function toReorderRequest(order: CurriculumOrder): ReorderCurriculumRequest {
  return ReorderCurriculumRequestSchema.parse({
    sections: order.map((section) => ({ sectionId: section.id, lectureIds: section.lectureIds })),
  });
}
