import { Injectable } from '@nestjs/common';
import {
  type AssetUsageKey,
  type DB,
  deleteAssetUsage,
  insertAssetUsage,
  lockAssets,
  releaseConsumerUsages,
  type Transaction,
} from '@udemy/db';
import type { AssetConsumerType } from '../application/dto';
import {
  AssetUsageRepository,
  type LockedAssetRecord,
} from '../application/ports/asset-usage.repository';
import { toPurpose, toStatus } from './kysely-media-asset.repository';
import { mapMediaConstraints } from './media-constraint-errors';

/**
 * `media.asset_usages` through the `@udemy/db` helpers (schema doc §8.3): assets are locked
 * ascending `FOR NO KEY UPDATE`; `unused_since`/`first_used_at` are trigger-owned and never
 * written here. Constraint violations become media domain errors (§9).
 */
@Injectable()
export class KyselyAssetUsageRepository extends AssetUsageRepository {
  async lockAssets(trx: Transaction<DB>, ids: readonly string[]): Promise<LockedAssetRecord[]> {
    const rows = await lockAssets(trx, ids);
    return rows.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      purpose: toPurpose(row.purpose),
      status: toStatus(row.status),
      purged: row.purgedAt !== null,
    }));
  }

  insert(trx: Transaction<DB>, usage: AssetUsageKey): Promise<boolean> {
    return mapMediaConstraints(() => insertAssetUsage(trx, usage));
  }

  delete(trx: Transaction<DB>, usage: AssetUsageKey): Promise<boolean> {
    return mapMediaConstraints(() => deleteAssetUsage(trx, usage));
  }

  releaseConsumer(
    trx: Transaction<DB>,
    consumer: { consumerType: AssetConsumerType; consumerId: string },
  ): Promise<string[]> {
    return mapMediaConstraints(() => releaseConsumerUsages(trx, consumer));
  }
}
