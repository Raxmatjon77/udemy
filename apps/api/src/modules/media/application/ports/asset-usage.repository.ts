import type { AssetUsageKey, DB, Transaction } from '@udemy/db';
import type { AssetConsumerType } from '../dto';
import type { MediaAssetStatus, MediaPurpose } from '../../domain/media-asset';

/** An asset row locked `FOR NO KEY UPDATE` (schema doc §8.3). */
export interface LockedAssetRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly purpose: MediaPurpose;
  readonly status: MediaAssetStatus;
  readonly purged: boolean;
}

/**
 * `media.asset_usages` (D8), always in the caller's transaction. Lock order: callers lock the
 * touched assets first, ascending by id (`lockAssets`), never `FOR SHARE`. Constraint
 * violations come back as media domain errors (schema doc §9).
 */
export abstract class AssetUsageRepository {
  abstract lockAssets(trx: Transaction<DB>, ids: readonly string[]): Promise<LockedAssetRecord[]>;
  /** Idempotent insert; true if a row was inserted. */
  abstract insert(trx: Transaction<DB>, usage: AssetUsageKey): Promise<boolean>;
  /** True if the usage existed. */
  abstract delete(trx: Transaction<DB>, usage: AssetUsageKey): Promise<boolean>;
  /** Deletes every usage of one consumer (locking its assets first); the released asset ids. */
  abstract releaseConsumer(
    trx: Transaction<DB>,
    consumer: { readonly consumerType: AssetConsumerType; readonly consumerId: string },
  ): Promise<string[]>;
}
