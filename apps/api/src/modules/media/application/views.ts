import type { AssetView, SignedUrl } from '@udemy/contracts';
import type { MediaAssetRecord } from './ports/media-asset.repository';
import type { SignedObjectUrl } from './ports/media-object.store';

/** `AssetView` (contracts) of a record. Progress is only meaningful while PROCESSING. */
export function toAssetView(asset: MediaAssetRecord): AssetView {
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    purpose: asset.purpose,
    status: asset.status,
    originalFilename: asset.originalFilename,
    sizeBytes: asset.declaredSizeBytes,
    progressPct: asset.status === 'PROCESSING' ? (asset.progressPct ?? 0) : null,
    failureCode: asset.status === 'FAILED' ? asset.failureCode : null,
    durationSeconds: asset.durationMs === null ? null : Math.round(asset.durationMs / 1000),
    width: asset.width,
    height: asset.height,
    renditions: [...asset.renditions],
    purged: asset.purged,
    createdAt: asset.createdAt.toISOString(),
  };
}

export function toSignedUrl(signed: SignedObjectUrl): SignedUrl {
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}
