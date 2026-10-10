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
      sections: { added: ['s1', 's2', 's3'], removed: [], changed: [], moved: [] },
      lectures: { added: ['l1', 'l2', 'l3', 'l4'], removed: [], changed: [], moved: [] },
    });
  });

  it('identical content: nothing changed', () => {
    const diff = diffRevisions(base, { id: 'r1', content: base });
    expect(diff.baseRevisionId).toBe('r1');
    expect(diff.changedFields).toEqual([]);
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
      sections: {
        added: ['s4'],
        removed: [{ id: 's3', title: 'Gone' }],
        changed: ['s2'],
        moved: ['s2', 's1'],
      },
      lectures: {
        added: ['l5', 'l6'],
        removed: [{ id: 'l4', title: 'Removed lecture', type: 'VIDEO' }],
        changed: ['l1'],
        moved: ['l1', 'l2'],
      },
    });
  });
});
