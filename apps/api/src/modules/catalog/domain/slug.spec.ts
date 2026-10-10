import { describe, expect, it } from 'vitest';
import {
  FALLBACK_SLUG,
  firstFreeSlug,
  isValidSlug,
  SLUG_MAX_LENGTH,
  slugBase,
  slugCandidate,
  slugCandidatePrefix,
  slugify,
} from './slug';

describe('slugify (D12 ASCII fold)', () => {
  it.each([
    ['Complete TypeScript Bootcamp 2026', 'complete-typescript-bootcamp-2026'],
    ['  --Hello,   World!!  ', 'hello-world'],
    ['Crème brûlée à la française', 'creme-brulee-a-la-francaise'],
    ['Straße & Ærø — Łódź', 'strasse-aero-lodz'],
    ['Oʻzbek tili: gʻalaba', 'ozbek-tili-galaba'],
    ['Программирование на Python', 'programmirovanie-na-python'],
    ['Йод, ёлка, щука', 'yod-yolka-shchuka'],
    ['Қазақ тілі ғылым', 'qazaq-tili-gylym'],
    ['C++ & C# for .NET', 'c-c-for-net'],
    ['ＦＵＬＬＷＩＤＴＨ １２３', 'fullwidth-123'],
  ])('%s -> %s', (title, slug) => {
    expect(slugify(title)).toBe(slug);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('returns "" when nothing transliterates; slugBase falls back', () => {
    expect(slugify('日本語のコース 🎉')).toBe('');
    expect(slugBase('日本語のコース 🎉')).toBe(FALLBACK_SLUG);
    expect(slugBase('🎉', 'category')).toBe('category');
  });

  it('cuts at 60 characters without a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(59)} bcd`);
    expect(slug).toBe('a'.repeat(59));
    expect(slugify('x'.repeat(100))).toHaveLength(SLUG_MAX_LENGTH);
  });
});

describe('slug candidates (-2, -3 on conflict)', () => {
  it('numbers candidates and keeps them within 60 characters', () => {
    expect(slugCandidate('intro', 1)).toBe('intro');
    expect(slugCandidate('intro', 2)).toBe('intro-2');
    const long = 'a'.repeat(30) + '-' + 'b'.repeat(29); // 60 chars
    const second = slugCandidate(long, 2);
    expect(second.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(second.endsWith('-2')).toBe(true);
    expect(isValidSlug(second)).toBe(true);
    expect(isValidSlug(slugCandidate(long, 12345))).toBe(true);
    expect(() => slugCandidate('x', 0)).toThrow(RangeError);
  });

  it('every candidate starts with the lookup prefix', () => {
    const base = 'c'.repeat(53) + '-defgh'; // 59 chars, hyphen at 53
    const prefix = slugCandidatePrefix(base);
    for (const n of [1, 2, 10, 999, 99999]) {
      expect(slugCandidate(base, n).startsWith(prefix)).toBe(true);
    }
  });

  it('picks the first free candidate', () => {
    expect(firstFreeSlug('intro', new Set())).toBe('intro');
    expect(firstFreeSlug('intro', new Set(['intro']))).toBe('intro-2');
    expect(firstFreeSlug('intro', new Set(['intro', 'intro-2', 'intro-4']))).toBe('intro-3');
    expect(firstFreeSlug('intro', new Set(['intro-2']))).toBe('intro');
  });
});
