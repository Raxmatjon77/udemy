/**
 * Catalog read helpers (docs/phase-2-schema-design.md §8.5), for the api's catalog use cases
 * (T10/T11). Pure SQL: authorisation, DTO mapping and cursor encoding stay in the use cases.
 */
import { sql } from 'kysely';
import { assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';

/** Page sizes are bounded here too; the API contract usually caps lower. */
const MAX_PAGE_SIZE = 200;

export interface TransitionHead {
  id: string;
  toStatus: string;
}

/**
 * Head of the course's transition chain = `prev_transition_id` for the next transition. Call it
 * while holding the course row lock (`SELECT ... FOR NO KEY UPDATE`), in the same transaction
 * that inserts the transition. Returns null for a course without history.
 */
export async function getTransitionHead(
  executor: Executor,
  courseId: string,
): Promise<TransitionHead | null> {
  const { rows } = await sql<TransitionHead>`
    SELECT t.id, t.to_status FROM catalog.course_transitions t
     WHERE t.course_id = ${courseId}
       AND NOT EXISTS (SELECT 1 FROM catalog.course_transitions n
                        WHERE n.course_id = ${courseId} AND n.prev_transition_id = t.id)
  `.execute(executor);
  if (rows.length > 1) {
    // Impossible while course_transitions_course_id_prev_transition_id_uq holds.
    throw new Error(`course ${courseId} has ${rows.length} transition heads`);
  }
  return rows[0] ?? null;
}

export interface ReviewQueueItem {
  courseId: string;
  ownerId: string;
  revisionId: string;
  revisionNo: number;
  kind: string;
  title: string;
  submittedAt: Date;
}

/**
 * Admin review queue, oldest first, keyset on the uuidv7 pending revision id
 * (courses_pending_revision_id_uq). `afterRevisionId` = last item's revisionId (omit on page 1).
 */
export async function listReviewQueue(
  executor: Executor,
  options: { limit: number; afterRevisionId?: string },
): Promise<ReviewQueueItem[]> {
  assertIntInRange('limit', options.limit, 1, MAX_PAGE_SIZE);
  let query = executor
    .selectFrom('catalog.courses as c')
    .innerJoin('catalog.courseRevisions as r', 'r.id', 'c.pendingRevisionId')
    .select([
      'c.id as courseId',
      'c.ownerId',
      'r.id as revisionId',
      'r.revisionNo',
      'r.kind',
      'r.title',
      'r.submittedAt',
    ])
    .where('c.pendingRevisionId', 'is not', null);
  if (options.afterRevisionId !== undefined) {
    query = query.where('c.pendingRevisionId', '>', options.afterRevisionId);
  }
  return query.orderBy('c.pendingRevisionId').limit(options.limit).execute();
}

/**
 * Keyset position. `firstPublishedAt` is the exact timestamptz as ISO-8601 UTC text WITH
 * microseconds (from `BrowseItem.cursor`): a JS Date keeps only milliseconds, and a truncated
 * cursor would make `(first_published_at, id) < cursor` skip rows published in the same ms.
 */
export interface BrowseCursor {
  firstPublishedAt: string;
  id: string;
}

export interface BrowseOptions {
  limit: number;
  /** Keyset: the last row of the previous page (omit on page 1). */
  after?: BrowseCursor;
  /** Live revision's category in this set (callers expand a root into its children). */
  categoryIds?: readonly string[];
  level?: string;
  language?: string;
  /** Substring of the live title (>= 3 chars to use the trigram index); LIKE wildcards are escaped. */
  titleContains?: string;
}

export interface BrowseItem {
  id: string;
  slug: string;
  ownerId: string;
  firstPublishedAt: Date;
  title: string;
  subtitle: string;
  level: string;
  language: string;
  categoryId: string;
  thumbnailAssetId: string;
  /** Pass as `after` to fetch the next page (encode it opaquely in the API). */
  cursor: BrowseCursor;
}

/** Escapes `\`, `%` and `_` for LIKE/ILIKE (default escape character `\`). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Public browse: PUBLISHED courses joined to their live revision, newest first, keyset on
 * (first_published_at, id) DESC (courses_first_published_at_id_idx).
 */
export async function browsePublishedCourses(
  executor: Executor,
  options: BrowseOptions,
): Promise<BrowseItem[]> {
  assertIntInRange('limit', options.limit, 1, MAX_PAGE_SIZE);
  let query = executor
    .selectFrom('catalog.courses as c')
    .innerJoin('catalog.courseRevisions as r', 'r.id', 'c.publishedRevisionId')
    .select([
      'c.id',
      'c.slug',
      'c.ownerId',
      'c.firstPublishedAt',
      'r.title',
      'r.subtitle',
      'r.level',
      'r.language',
      'r.categoryId',
      'r.thumbnailAssetId',
      sql<string>`to_char(c.first_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'cursorAt',
      ),
    ])
    .where('c.status', '=', 'PUBLISHED');
  if (options.categoryIds !== undefined) {
    if (options.categoryIds.length === 0) return [];
    query = query.where('r.categoryId', '=', sql<string>`ANY(${[...options.categoryIds]}::uuid[])`);
  }
  if (options.level !== undefined) query = query.where('r.level', '=', options.level);
  if (options.language !== undefined) query = query.where('r.language', '=', options.language);
  if (options.titleContains !== undefined && options.titleContains !== '') {
    query = query.where('r.title', 'ilike', `%${escapeLikePattern(options.titleContains)}%`);
  }
  if (options.after !== undefined) {
    const { firstPublishedAt, id } = options.after;
    query = query.where(
      sql<boolean>`(c.first_published_at, c.id) < (${firstPublishedAt}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await query
    .orderBy('c.firstPublishedAt', 'desc')
    .orderBy('c.id', 'desc')
    .limit(options.limit)
    .execute();
  // PUBLISHED implies first_published_at IS NOT NULL (courses_first_published_at_ck).
  return rows.map(({ cursorAt, ...row }) => ({
    ...row,
    firstPublishedAt: row.firstPublishedAt as Date,
    cursor: { firstPublishedAt: cursorAt, id: row.id },
  }));
}
