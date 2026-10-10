import {
  BrowseCoursesQuerySchema,
  CourseLanguageSchema,
  CourseLevelSchema,
  CursorSchema,
  type CourseLanguage,
  type CourseLevel,
} from '@udemy/contracts';

/**
 * The browse filters as they live in the page URL (`/courses?category=&level=&language=&q=`),
 * and their translation into the API query (`GET /catalog/courses`, contracts
 * `BrowseCoursesQuerySchema`). Isomorphic: used by the server pages and the client filter bar.
 *
 * URL values are user input: anything the contract would reject is dropped (and reported in
 * `ignored`) instead of failing the page, so a hand-edited link still shows a catalog.
 */

export interface BrowseFilters {
  category?: string;
  level?: CourseLevel;
  language?: CourseLanguage;
  q?: string;
}

export const BROWSE_FILTER_KEYS = ['category', 'level', 'language', 'q'] as const;
export type BrowseFilterKey = (typeof BROWSE_FILTER_KEYS)[number];

/** Minimum search length (the API's trigram search needs 3 characters). */
export const SEARCH_MIN_LENGTH = 3;

/** Next's `searchParams` shape, or a URLSearchParams. */
export type SearchParamsInput =
  URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

function first(input: SearchParamsInput, key: string): string | undefined {
  if (input instanceof URLSearchParams) return input.get(key) ?? undefined;
  const value = input[key];
  return typeof value === 'string' ? value : value?.[0];
}

const fieldSchemas = BrowseCoursesQuerySchema.shape;

export interface ParsedBrowseFilters {
  filters: BrowseFilters;
  /** Keys present in the URL with a value the contract does not accept. */
  ignored: BrowseFilterKey[];
}

export function parseBrowseFilters(input: SearchParamsInput): ParsedBrowseFilters {
  const filters: BrowseFilters = {};
  const ignored: BrowseFilterKey[] = [];
  for (const key of BROWSE_FILTER_KEYS) {
    const raw = first(input, key);
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = fieldSchemas[key].safeParse(raw);
    if (parsed.success && parsed.data !== undefined) {
      (filters as Record<string, string>)[key] = parsed.data;
    } else {
      ignored.push(key);
    }
  }
  return { filters, ignored };
}

/** Canonical query string of the filters (stable key order, empty values skipped), `?…` or ''. */
export function filtersToSearch(filters: BrowseFilters): string {
  const search = new URLSearchParams();
  for (const key of BROWSE_FILTER_KEYS) {
    const value = filters[key];
    if (value) search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

/**
 * API path of one browse page: `/catalog/courses?category=…&cursor=…&limit=…`. The cursor is
 * passed through byte for byte: it is the exact opaque text the API produced (design §14,
 * keyset cursors over timestamps must not be re-encoded or round-tripped through a Date).
 */
export function browseApiPath(
  filters: BrowseFilters,
  page: { cursor?: string | null; limit?: number } = {},
): string {
  const search = new URLSearchParams(filtersToSearch(filters));
  if (page.cursor) {
    if (!CursorSchema.safeParse(page.cursor).success) throw new Error('Invalid cursor');
    search.set('cursor', page.cursor);
  }
  if (page.limit !== undefined) search.set('limit', String(page.limit));
  const out = search.toString();
  return `/catalog/courses${out ? `?${out}` : ''}`;
}

export function hasActiveFilters(filters: BrowseFilters): boolean {
  return BROWSE_FILTER_KEYS.some((key) => Boolean(filters[key]));
}

export function isCourseLevel(value: string): value is CourseLevel {
  return CourseLevelSchema.safeParse(value).success;
}

export function isCourseLanguage(value: string): value is CourseLanguage {
  return CourseLanguageSchema.safeParse(value).success;
}
