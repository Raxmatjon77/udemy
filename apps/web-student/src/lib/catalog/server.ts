import 'server-only';
import {
  CategoryTreeResponseSchema,
  CourseCardPageSchema,
  CourseLandingSchema,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  type CategoryNode,
  type CourseCardPage,
  type CourseLanding,
} from '@udemy/contracts';
import {
  ApiProblemError,
  ApiUnavailableError,
  apiFetch,
  lazyWebAuthConfig,
  readProblem,
} from '@udemy/web-auth';
import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { cache } from 'react';
import type { z } from 'zod';

import { webAuthConfig } from '../auth/config';
import { browseApiPath, type BrowseFilters } from './browse-params';

/**
 * Server-side reads of the public catalog (design §8 "Public catalog", §10 web-student).
 *
 * Server components call the API directly (`API_INTERNAL_URL`) with the BFF client credentials
 * and WITHOUT the visitor's session: the public catalog is the same for everybody, and a page
 * fetched anonymously can never leak one user's view to another. The visitor's IP and user
 * agent are forwarded as on every BFF call (rate limits, logs).
 *
 * Errors: a 404 is a value (`null`) where the caller has a not-found page; everything else
 * throws `ApiProblemError` (other 4xx) or `ApiUnavailableError` (5xx, network, contract
 * mismatch), for the page to turn into an error state.
 */

const getConfig = lazyWebAuthConfig(webAuthConfig);

const FORWARDED_REQUEST_HEADERS = ['user-agent', 'x-real-ip', 'x-forwarded-for'] as const;

/** A stand-in for the incoming request: what `apiFetch` reads from it (IP, user agent). */
async function incomingRequest(appOrigin: string): Promise<Request> {
  const incoming = await headers();
  const forwarded = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value) forwarded.set(name, value);
  }
  return new Request(appOrigin, { headers: forwarded });
}

/** Frees the connection of a response whose body is not needed (never awaited: it can stall). */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { notFoundAsNull: true },
): Promise<T | null>;
async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T>;
async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { notFoundAsNull?: boolean } = {},
): Promise<T | null> {
  const config = getConfig();
  const response = await apiFetch(config, path, await incomingRequest(config.appOrigin));
  if (response.status === 404 && options.notFoundAsNull) {
    discard(response);
    return null;
  }
  if (response.status >= 500) {
    discard(response);
    throw new ApiUnavailableError(`API answered ${response.status} for ${path}`);
  }
  if (!response.ok) {
    throw new ApiProblemError(await readProblem(response), response.headers.get('retry-after'));
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiUnavailableError(`API response for ${path} does not match the contract`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** `GET /catalog/categories`: active categories, ordered (memoised per request). */
export const getCategoryTree = cache(async (): Promise<CategoryNode[]> => {
  const tree = await getJson('/catalog/categories', CategoryTreeResponseSchema);
  return tree.items;
});

/** `GET /catalog/courses`: one keyset page. */
export async function browseCourses(
  filters: BrowseFilters,
  page: { cursor?: string | null; limit?: number } = {},
): Promise<CourseCardPage> {
  return getJson(browseApiPath(filters, page), CourseCardPageSchema);
}

export function isPlausibleSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/**
 * `GET /catalog/courses/by-slug/:slug`, or null when there is no published course with that
 * slug. Memoised per request, so `generateMetadata` and the page share one API call.
 */
export const getCourseLanding = cache(async (slug: string): Promise<CourseLanding | null> => {
  // Not a slug at all: no need to ask the API (and nothing odd ever reaches its path).
  if (!isPlausibleSlug(slug)) return null;
  return getJson(`/catalog/courses/by-slug/${slug}`, CourseLandingSchema, {
    notFoundAsNull: true,
  });
});

/** The data a page needs, or the fact that the catalog could not be loaded. */
export type Loaded<T> = { ok: true; data: T } | { ok: false; error: unknown };

/**
 * Runs a catalog read for a page section that has its own error state: the page still renders
 * (header, other sections) when the API is down. The error is kept for the caller; it is
 * logged to stderr because nothing else would surface it (structured logging: Phase 7).
 */
export async function settle<T>(read: Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await read };
  } catch (error) {
    // Next's own control flow (dynamic-rendering bailout, notFound, redirect) must propagate,
    // or a prerender attempt would bake the error state into a static page.
    unstable_rethrow(error);
    // eslint-disable-next-line no-console -- server-side only; no logger in the web apps yet
    console.error('[catalog] read failed:', error instanceof Error ? error.message : error);
    return { ok: false, error };
  }
}
