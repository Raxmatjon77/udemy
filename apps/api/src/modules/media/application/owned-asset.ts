import type { Executor } from '@udemy/db';
import { MediaAssetNotFound } from '../domain/media.errors';
import type { MediaAssetRecord, MediaAssetRepository } from './ports/media-asset.repository';

/**
 * Loads an asset of `ownerId`. A missing or foreign asset is 404 `media_asset_not_found`
 * (never 403, so ids cannot be probed). The PoliciesGuard already checked ownership; this is
 * the use case's own defence in depth (e.g. for non-HTTP callers).
 */
export async function loadOwnedAsset(
  assets: MediaAssetRepository,
  assetId: string,
  ownerId: string,
  ex?: Executor,
): Promise<MediaAssetRecord> {
  const asset = await assets.findById(assetId, ex);
  if (asset === null || asset.ownerId !== ownerId) throw new MediaAssetNotFound();
  return asset;
}
