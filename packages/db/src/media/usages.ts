/**
 * MediaFacade locking and usage rows (docs/phase-2-schema-design.md §8.3), for catalog's use
 * cases through MediaFacade (api, T8-T10), always inside catalog's transaction.
 *
 * Rules (schema doc §6 items 3, 9, 12):
 * - Lock every touched asset first, ascending by id, `FOR NO KEY UPDATE` (never FOR SHARE).
 *   Lock order overall: course row -> category (FOR SHARE) -> asset rows ascending.
 * - Swapping an asset: release the old usage BEFORE using the new one.
 * - Never write assets.unused_since / first_used_at: the asset_usages triggers maintain them.
 * - READ COMMITTED only.
 */
import { sql } from 'kysely';
import { type Executor, requireTransaction } from '../transaction';

export const ASSET_CONSUMER_TYPES = [
  'catalog.lecture',
  'catalog.course_thumbnail',
  'catalog.course_revision',
] as const;
export type AssetConsumerType = (typeof ASSET_CONSUMER_TYPES)[number];

export interface AssetUsageKey {
  assetId: string;
  consumerType: AssetConsumerType;
  consumerId: string;
}

export interface LockedAsset {
  id: string;
  ownerId: string;
  purpose: string;
  status: string;
  purgedAt: Date | null;
}

/** Locks the given assets (deduplicated, ascending id, FOR NO KEY UPDATE). Missing ids are absent. */
export async function lockAssets(
  executor: Executor,
  assetIds: readonly string[],
): Promise<LockedAsset[]> {
  const trx = requireTransaction(executor, 'lockAssets');
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return [];
  const { rows } = await sql<LockedAsset>`
    SELECT id, owner_id, purpose, status, purged_at FROM media.assets
     WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE
  `.execute(trx);
  return rows;
}

/**
 * use/pin: inserts the usage (idempotent). Returns true if a row was inserted. Errors to map:
 * asset_usages_asset_usable_ck, asset_usages_purpose_ck, asset_usages_asset_id_fk,
 * asset_usages_asset_id_working_uq / asset_usages_consumer_working_uq (§9).
 */
export async function insertAssetUsage(executor: Executor, usage: AssetUsageKey): Promise<boolean> {
  const result = await executor
    .insertInto('media.assetUsages')
    .values({
      assetId: usage.assetId,
      consumerType: usage.consumerType,
      consumerId: usage.consumerId,
    })
    .onConflict((oc) => oc.columns(['assetId', 'consumerType', 'consumerId']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1;
}

/** release: deletes one usage. Returns true if it existed. */
export async function deleteAssetUsage(executor: Executor, usage: AssetUsageKey): Promise<boolean> {
  const result = await executor
    .deleteFrom('media.assetUsages')
    .where('assetId', '=', usage.assetId)
    .where('consumerType', '=', usage.consumerType)
    .where('consumerId', '=', usage.consumerId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) === 1;
}

/**
 * releaseConsumer: e.g. every pin of a superseded revision. Locks the consumer's assets in
 * ascending order first, then deletes its usages. Returns the released asset ids.
 */
export async function releaseConsumerUsages(
  executor: Executor,
  consumer: { consumerType: AssetConsumerType; consumerId: string },
): Promise<string[]> {
  const trx = requireTransaction(executor, 'releaseConsumerUsages');
  const held = await trx
    .selectFrom('media.assetUsages')
    .select('assetId')
    .where('consumerType', '=', consumer.consumerType)
    .where('consumerId', '=', consumer.consumerId)
    .orderBy('assetId')
    .execute();
  if (held.length === 0) return [];
  await lockAssets(
    trx,
    held.map((r) => r.assetId),
  );
  const deleted = await trx
    .deleteFrom('media.assetUsages')
    .where('consumerType', '=', consumer.consumerType)
    .where('consumerId', '=', consumer.consumerId)
    .returning('assetId')
    .execute();
  return deleted.map((r) => r.assetId).sort();
}
