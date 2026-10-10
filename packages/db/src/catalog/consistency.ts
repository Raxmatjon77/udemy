/**
 * catalog <-> media soft-reference drift detection (docs/phase-2-schema-design.md §8.6). Not
 * DB-enforceable without cross-schema coupling (D12); run in integration tests and as an ops
 * check. Both should always return no rows.
 */
import { sql } from 'kysely';
import type { Executor } from '../transaction';

export interface LectureWithoutUsage {
  id: string;
  mediaAssetId: string;
}

/** Lectures that point at an asset without the matching `catalog.lecture` usage row. */
export async function findLecturesWithoutUsage(
  executor: Executor,
  options: { limit: number } = { limit: 100 },
): Promise<LectureWithoutUsage[]> {
  const { rows } = await sql<LectureWithoutUsage>`
    SELECT l.id, l.media_asset_id FROM catalog.lectures l
     WHERE l.media_asset_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM media.asset_usages u WHERE u.asset_id = l.media_asset_id
                         AND u.consumer_type = 'catalog.lecture' AND u.consumer_id = l.id)
     LIMIT ${options.limit}
  `.execute(executor);
  return rows;
}

export interface LeakedUsage {
  assetId: string;
  consumerType: string;
  consumerId: string;
  createdAt: Date;
}

/** Usages whose consumer no longer points at the asset (a leaked pin blocks purge forever). */
export async function findLeakedUsages(
  executor: Executor,
  options: { limit: number } = { limit: 100 },
): Promise<LeakedUsage[]> {
  const { rows } = await sql<LeakedUsage>`
    SELECT u.asset_id, u.consumer_type, u.consumer_id, u.created_at FROM media.asset_usages u
     WHERE (u.consumer_type = 'catalog.lecture'
            AND NOT EXISTS (SELECT 1 FROM catalog.lectures l WHERE l.id = u.consumer_id AND l.media_asset_id = u.asset_id))
        OR (u.consumer_type = 'catalog.course_thumbnail'
            AND NOT EXISTS (SELECT 1 FROM catalog.courses c WHERE c.id = u.consumer_id AND c.thumbnail_asset_id = u.asset_id))
        OR (u.consumer_type = 'catalog.course_revision'
            AND NOT EXISTS (SELECT 1 FROM catalog.courses c
                             WHERE c.pending_revision_id = u.consumer_id OR c.published_revision_id = u.consumer_id))
     LIMIT ${options.limit}
  `.execute(executor);
  return rows;
}
