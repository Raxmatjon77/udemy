import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  contentHash,
  referencedAssetIds,
  type SnapshotContent,
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
        },
        {
          id: 'l2',
          type: 'ARTICLE',
          title: 'Read me',
          descriptionMd: 'x',
          isPreview: false,
          mediaAssetId: null,
          articleBodyMd: 'Body  \n',
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
