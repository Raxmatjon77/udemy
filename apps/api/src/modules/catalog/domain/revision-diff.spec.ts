import { RevisionFieldChangeSchema } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { diffRevisions } from './revision-diff';
import type { SnapshotContent, SnapshotLecture } from './revision-snapshot';

const lecture = (
  id: string,
  title: string,
  extra: Partial<SnapshotLecture> = {},
): SnapshotLecture => ({
  id,
  type: 'VIDEO',
  title,
  descriptionMd: null,
  isPreview: false,
  mediaAssetId: `asset-${id}`,
  articleBodyMd: null,
  quiz: null,
  ...extra,
});

const base: SnapshotContent = {
  title: 'Course title',
  subtitle: 'A subtitle here',
  descriptionMd: 'desc',
  language: 'en',
  level: 'BEGINNER',
  categoryId: 'c1',
  thumbnailAssetId: 't1',
  outcomes: ['a', 'b'],
  requirements: [],
  sections: [
    {
      id: 's1',
      title: 'One',
      objective: null,
      lectures: [lecture('l1', 'L1'), lecture('l2', 'L2')],
    },
    { id: 's2', title: 'Two', objective: null, lectures: [lecture('l3', 'L3')] },
    { id: 's3', title: 'Gone', objective: null, lectures: [lecture('l4', 'Removed lecture')] },
  ],
};

describe('diffRevisions', () => {
  it('INITIAL (no base): everything is added', () => {
    expect(diffRevisions(base, null)).toEqual({
      baseRevisionId: null,
      changedFields: [],
      fieldChanges: [],
      sections: { added: ['s1', 's2', 's3'], removed: [], changed: [], moved: [] },
      lectures: { added: ['l1', 'l2', 'l3', 'l4'], removed: [], changed: [], moved: [] },
    });
  });

  it('identical content: nothing changed', () => {
    const diff = diffRevisions(base, { id: 'r1', content: base });
    expect(diff.baseRevisionId).toBe('r1');
    expect(diff.changedFields).toEqual([]);
    expect(diff.fieldChanges).toEqual([]);
    expect(diff.sections).toEqual({ added: [], removed: [], changed: [], moved: [] });
    expect(diff.lectures).toEqual({ added: [], removed: [], changed: [], moved: [] });
  });

  it('reports header fields, added/removed (with titles)/changed/moved items', () => {
    const next: SnapshotContent = {
      ...base,
      title: 'New course title',
      outcomes: ['b', 'a'],
      thumbnailAssetId: 't2',
      sections: [
        // s2 moved to the front and renamed; l1 moved into it and changed
        {
          id: 's2',
          title: 'Two (renamed)',
          objective: null,
          lectures: [lecture('l3', 'L3'), lecture('l1', 'L1', { isPreview: true })],
        },
        {
          id: 's1',
          title: 'One',
          objective: null,
          lectures: [lecture('l2', 'L2'), lecture('l5', 'New')],
        },
        { id: 's4', title: 'Fresh', objective: 'x', lectures: [lecture('l6', 'Six')] },
      ],
    };
    expect(diffRevisions(next, { id: 'r1', content: base })).toEqual({
      baseRevisionId: 'r1',
      changedFields: ['title', 'thumbnailAssetId', 'outcomes'],
      fieldChanges: [
        { field: 'title', before: 'Course title', after: 'New course title' },
        { field: 'thumbnailAssetId', before: 't1', after: 't2' },
        { field: 'outcomes', before: ['a', 'b'], after: ['b', 'a'] },
      ],
      sections: {
        added: ['s4'],
        removed: [{ id: 's3', title: 'Gone' }],
        changed: ['s2'],
        moved: ['s2', 's1'],
      },
      lectures: {
        added: ['l5', 'l6'],
        removed: [
          {
            id: 'l4',
            title: 'Removed lecture',
            type: 'VIDEO',
            sectionId: 's3',
            sectionTitle: 'Gone',
          },
        ],
        changed: ['l1'],
        moved: ['l1', 'l2'],
      },
    });
  });

  it('field changes carry null and list values, and are valid RevisionFieldChanges', () => {
    const next: SnapshotContent = {
      ...base,
      subtitle: null,
      level: 'EXPERT',
      categoryId: null,
      requirements: ['git'],
    };
    const diff = diffRevisions(next, { id: 'r1', content: { ...base, level: null } });
    expect(diff.changedFields).toEqual(['subtitle', 'level', 'categoryId', 'requirements']);
    expect(diff.fieldChanges).toEqual([
      { field: 'subtitle', before: 'A subtitle here', after: null },
      { field: 'level', before: null, after: 'EXPERT' },
      { field: 'categoryId', before: 'c1', after: null },
      { field: 'requirements', before: [], after: ['git'] },
    ]);
    for (const change of diff.fieldChanges ?? []) {
      expect(RevisionFieldChangeSchema.parse(change)).toEqual(change);
    }
  });

  it('a removed lecture of a kept section names that section', () => {
    const next: SnapshotContent = {
      ...base,
      sections: base.sections.map((s) =>
        s.id === 's1' ? { ...s, lectures: s.lectures.filter((l) => l.id !== 'l2') } : s,
      ),
    };
    expect(diffRevisions(next, { id: 'r1', content: base }).lectures.removed).toEqual([
      { id: 'l2', title: 'L2', type: 'VIDEO', sectionId: 's1', sectionTitle: 'One' },
    ]);
  });
});

describe('diffRevisions: QUIZ lectures (Phase 5 D6)', () => {
  const quizLecture = (passPct: number, correctFirst: boolean): SnapshotLecture =>
    lecture('q1', 'Quiz', {
      type: 'QUIZ',
      mediaAssetId: null,
      quiz: {
        passPct,
        questions: [
          {
            id: 'qq1',
            kind: 'SINGLE_CHOICE',
            promptMd: 'Pick',
            explanationMd: null,
            options: [
              { text: 'A', isCorrect: correctFirst },
              { text: 'B', isCorrect: !correctFirst },
            ],
          },
        ],
      },
    });
  const course = (q: SnapshotLecture): SnapshotContent => ({
    ...base,
    sections: [{ id: 's1', title: 'S', objective: null, lectures: [q] }],
  });

  it('an unchanged quiz is not changed', () => {
    const diff = diffRevisions(course(quizLecture(70, true)), {
      id: 'base',
      content: course(quizLecture(70, true)),
    });
    expect(diff.lectures.changed).toEqual([]);
  });

  it('a new answer key or pass mark marks the lecture changed', () => {
    for (const next of [quizLecture(70, false), quizLecture(80, true)]) {
      const diff = diffRevisions(course(next), {
        id: 'base',
        content: course(quizLecture(70, true)),
      });
      expect(diff.lectures.changed).toEqual(['q1']);
    }
  });
});
