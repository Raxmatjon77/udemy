import { Injectable } from '@nestjs/common';
import type { AssetView, MediaPurpose, SignedUrl } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import { assertAttachableAs, assertPinnable } from '../domain/media-asset';
import { MediaAssetNotFound, MediaPurposeMismatch } from '../domain/media.errors';
import type { AssetConsumer, ImageVariant } from './dto';
import { MediaPlaybackService } from './media-playback.service';
import { AssetUsageRepository } from './ports/asset-usage.repository';
import { MediaAssetRepository } from './ports/media-asset.repository';
import { toAssetView } from './views';

/** Which asset purposes a working-copy consumer accepts (mirrors `asset_usages_purpose_ck`). */
const CONSUMER_PURPOSES: Readonly<Record<AssetConsumer['type'], readonly MediaPurpose[] | null>> = {
  'catalog.lecture': ['LECTURE_VIDEO', 'LECTURE_RESOURCE'],
  'catalog.course_thumbnail': ['COURSE_THUMBNAIL'],
  // Pins accept any purpose, but only READY assets (see pinRevisionAssets).
  'catalog.course_revision': null,
};

/**
 * Public API of the media context for other modules (design §3), used by catalog (P2-T9..T11).
 *
 * Write methods take the CALLER's transaction first (catalog's course lock is already held):
 * - lock order: course row -> category -> asset rows ascending `FOR NO KEY UPDATE` (never
 *   FOR SHARE, schema doc §6 items 3 and 9);
 * - swapping an asset is release-then-use (item 12), so `asset_usages_consumer_working_uq`
 *   never sees two rows for one consumer;
 * - READ COMMITTED only (the usage triggers rely on it, item 5).
 *
 * Foreign or missing assets are always `media_asset_not_found` (404), never 403.
 * Playback AUTHORIZATION is catalog's job: the render/presign methods serve any asset id they
 * are given.
 */
@Injectable()
export class MediaFacade {
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly usages: AssetUsageRepository,
    private readonly playback: MediaPlaybackService,
  ) {}

  /**
   * Views of the existing assets among `ids`, in request order (missing ids omitted). Pass the
   * caller's transaction to read fresh states inside it (e.g. readiness at submit).
   */
  async getAssets(ids: readonly string[], ex?: Executor): Promise<AssetView[]> {
    if (ids.length === 0) return [];
    const byId = new Map((await this.assets.findByIds(ids, ex)).map((a) => [a.id, a]));
    return [...new Set(ids)].flatMap((id) => {
      const asset = byId.get(id);
      return asset === undefined ? [] : [toAssetView(asset)];
    });
  }

  /**
   * Read-only pre-check for a form or a use case before it takes locks: `ownerId` owns
   * `assetId`, it was uploaded as `purpose`, and it is usable (not FAILED/ABORTED/purged).
   *
   * @throws MediaAssetNotFound (404), MediaPurposeMismatch (422), MediaAssetUnusable (409)
   */
  async assertAttachable(
    ownerId: string,
    assetId: string,
    purpose: MediaPurpose,
    ex?: Executor,
  ): Promise<AssetView> {
    const asset = await this.assets.findById(assetId, ex);
    if (asset === null || asset.ownerId !== ownerId) throw new MediaAssetNotFound();
    assertAttachableAs(asset, purpose);
    return toAssetView(asset);
  }

  /**
   * Attaches an asset to a working-copy consumer (lecture or course thumbnail) in `trx`:
   * locks the asset, checks owner (404), purpose (422) and usability (409), then inserts the
   * usage (idempotent). An asset already used by another lecture/course is 409
   * `media_asset_unusable`. Release the consumer's previous asset BEFORE calling this.
   */
  async useAsset(
    trx: Transaction<DB>,
    input: {
      readonly assetId: string;
      readonly ownerId: string;
      readonly purpose: MediaPurpose;
      readonly consumer: AssetConsumer;
    },
  ): Promise<AssetView> {
    const allowed = CONSUMER_PURPOSES[input.consumer.type];
    if (allowed === null) {
      throw new TypeError('useAsset is for working-copy consumers; use pinRevisionAssets');
    }
    if (!allowed.includes(input.purpose)) {
      throw new MediaPurposeMismatch({ expected: input.purpose });
    }
    const [locked] = await this.usages.lockAssets(trx, [input.assetId]);
    if (locked === undefined || locked.ownerId !== input.ownerId) throw new MediaAssetNotFound();
    assertAttachableAs(locked, input.purpose);
    await this.usages.insert(trx, {
      assetId: input.assetId,
      consumerType: input.consumer.type,
      consumerId: input.consumer.id,
    });
    const view = await this.assets.findById(input.assetId, trx);
    if (view === null) throw new MediaAssetNotFound();
    return toAssetView(view);
  }

  /**
   * Detaches one asset from one consumer in `trx` (locks the asset first). Returns false when
   * there was no such usage. The asset becomes purge-eligible after the grace period when this
   * was its last usage (trigger-maintained `unused_since`).
   */
  async releaseAsset(
    trx: Transaction<DB>,
    input: { readonly assetId: string; readonly consumer: AssetConsumer },
  ): Promise<boolean> {
    await this.usages.lockAssets(trx, [input.assetId]);
    return this.usages.delete(trx, {
      assetId: input.assetId,
      consumerType: input.consumer.type,
      consumerId: input.consumer.id,
    });
  }

  /**
   * Pins the assets of a submitted revision (`catalog.course_revision` = revisionId) in `trx`:
   * locks them all ascending, requires each to exist and be READY, then inserts the pins in id
   * order. The caller has already validated ownership and purposes through the working copy.
   *
   * @throws MediaAssetNotFound (404) for a missing id, MediaAssetUnusable (409) if not READY
   */
  async pinRevisionAssets(
    trx: Transaction<DB>,
    input: { readonly revisionId: string; readonly assetIds: readonly string[] },
  ): Promise<void> {
    const ids = [...new Set(input.assetIds)].sort();
    if (ids.length === 0) return;
    const locked = await this.usages.lockAssets(trx, ids);
    if (locked.length !== ids.length) throw new MediaAssetNotFound();
    for (const asset of locked) assertPinnable(asset);
    for (const assetId of ids) {
      await this.usages.insert(trx, {
        assetId,
        consumerType: 'catalog.course_revision',
        consumerId: input.revisionId,
      });
    }
  }

  /**
   * Releases every usage of one consumer in `trx` (a superseded, rejected or withdrawn
   * revision; a deleted lecture). Returns the released asset ids, ascending.
   */
  releaseConsumer(trx: Transaction<DB>, consumer: AssetConsumer): Promise<string[]> {
    return this.usages.releaseConsumer(trx, {
      consumerType: consumer.type,
      consumerId: consumer.id,
    });
  }

  /** @throws MediaNotReady (409) unless a READY video; MediaAssetNotFound (404) */
  renderMasterPlaylist(assetId: string): Promise<string> {
    return this.playback.renderMasterPlaylist(assetId);
  }

  /** @throws RenditionNotFound (404) for a rendition the asset does not have */
  renderVariantPlaylist(assetId: string, rendition: string): Promise<string> {
    return this.playback.renderVariantPlaylist(assetId, rendition);
  }

  presignImage(assetId: string, variant: ImageVariant): Promise<SignedUrl> {
    return this.playback.presignImage(assetId, variant);
  }

  presignDownload(assetId: string, downloadName: string): Promise<SignedUrl> {
    return this.playback.presignDownload(assetId, downloadName);
  }
}
