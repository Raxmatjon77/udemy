import { describe, expect, it } from 'vitest';

import { CURSOR_PAGE_2 } from '@/test/fixtures/catalog';

import { browseApiPath, filtersToSearch, parseBrowseFilters } from './browse-params';

describe('parseBrowseFilters', () => {
  it('keeps the filters the contract accepts', () => {
    const { filters, ignored } = parseBrowseFilters({
      category: 'web-development',
      level: 'BEGINNER',
      language: 'pt-BR',
      q: '  typescript  ',
      cursor: 'ignored-here',
    });
    expect(filters).toEqual({
      category: 'web-development',
      level: 'BEGINNER',
      language: 'pt-BR',
      q: 'typescript',
    });
    expect(ignored).toEqual([]);
  });

  it('drops (and reports) values the API would reject instead of failing the page', () => {
    const { filters, ignored } = parseBrowseFilters(
      new URLSearchParams('category=Not_A_Slug&level=GURU&language=xx&q=ab'),
    );
    expect(filters).toEqual({});
    expect(ignored).toEqual(['category', 'level', 'language', 'q']);
  });

  it('treats empty values as absent and takes the first of repeated keys', () => {
    expect(parseBrowseFilters({ level: '', q: ['react hooks', 'vue'] })).toEqual({
      filters: { q: 'react hooks' },
      ignored: [],
    });
  });
});

describe('filtersToSearch / browseApiPath', () => {
  it('builds a canonical URL query in a stable key order', () => {
    expect(filtersToSearch({ q: 'node js', level: 'EXPERT', category: 'design' })).toBe(
      '?category=design&level=EXPERT&q=node+js',
    );
    expect(filtersToSearch({})).toBe('');
  });

  it('passes the keyset cursor through byte for byte, with the limit', () => {
    const path = browseApiPath({ level: 'BEGINNER' }, { cursor: CURSOR_PAGE_2, limit: 24 });
    expect(path).toBe(`/catalog/courses?level=BEGINNER&cursor=${CURSOR_PAGE_2}&limit=24`);
    expect(new URL(path, 'http://x').searchParams.get('cursor')).toBe(CURSOR_PAGE_2);
  });

  it('refuses a cursor that is not opaque base64url text', () => {
    expect(() => browseApiPath({}, { cursor: 'a&limit=1000' })).toThrow('Invalid cursor');
  });
});
