import { Injectable } from '@nestjs/common';
import type { MediaPurpose, SignedUrl } from '@udemy/contracts';
import { attachmentContentDisposition, resolvePlaylistUri, resourceKey } from '@udemy/storage';
import {
  type HlsVariant,
  parseVariantPlaylist,
  playlistUris,
  renderMasterPlaylist,
  serializePlaylist,
} from '../domain/hls-playlist';
import {
  MediaAssetNotFound,
  MediaNotReady,
  MediaPurposeMismatch,
  PlaylistRejected,
  RenditionNotFound,
} from '../domain/media.errors';
import { IMAGE_VARIANTS, type ImageVariant } from './dto';
import { MediaSettings } from './media-settings';
import { PlaylistCache } from './playlist-cache';
import {
  type MediaAssetRecord,
  MediaAssetRepository,
  type RenditionRecord,
} from './ports/media-asset.repository';
import { MediaObjectStore } from './ports/media-object.store';
import { toSignedUrl } from './views';

/** Content types forced on presigned GETs (D11: we decide what browsers see, not the object). */
const IMAGE_CONTENT_TYPE = 'image/jpeg';
const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * Playlists and signed URLs for READY assets (design D7, D11). Authorization is NOT done here:
 * catalog decides who may watch or download (preview / owner / admin / entitlements) and only
 * then asks for an asset id it resolved itself.
 */
@Injectable()
export class MediaPlaybackService {
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly storage: MediaObjectStore,
    private readonly cache: PlaylistCache,
    private readonly settings: MediaSettings,
  ) {}

  /** `master.m3u8` from the HLS_VARIANT rows; variant URIs are relative (`720p.m3u8`). */
  async renderMasterPlaylist(assetId: string): Promise<string> {
    const asset = await this.readyAsset(assetId, 'LECTURE_VIDEO');
    const variants = (await this.assets.findRenditions(asset.id)).flatMap(toHlsVariant);
    if (variants.length === 0) throw new MediaNotReady();
    return renderMasterPlaylist(variants);
  }

  /**
   * `{rendition}.m3u8`: the stored variant playlist (cached per immutable object key) with
   * every segment line replaced by a presigned GET (TTL `MEDIA_PLAYBACK_URL_TTL_S`). The
   * rendition name is validated against the DB rows, and every segment URI must resolve below
   * the playlist's own directory (`resolvePlaylistUri`), so no other object can be signed.
   *
   * @throws RenditionNotFound (404) for a rendition the asset does not have
   * @throws PlaylistRejected (500) for a tampered or foreign playlist (traversal, URI tags)
   */
  async renderVariantPlaylist(assetId: string, rendition: string): Promise<string> {
    const asset = await this.readyAsset(assetId, 'LECTURE_VIDEO');
    const row = (await this.assets.findRenditions(asset.id)).find(
      (r) => r.kind === 'HLS_VARIANT' && r.name === rendition,
    );
    if (row === undefined) throw new RenditionNotFound();
    const playlistKey = row.objectKey;
    if (asset.outputPrefix === null || !playlistKey.startsWith(asset.outputPrefix)) {
      throw new PlaylistRejected('the playlist is outside the asset output prefix');
    }

    const lines = parseVariantPlaylist(await this.playlistText(playlistKey));
    const ttlSeconds = this.settings.values.playbackUrlTtlSeconds;
    const signed = new Map<string, string>();
    await Promise.all(
      [...new Set(playlistUris(lines))].map(async (uri) => {
        let key: string;
        try {
          key = resolvePlaylistUri(playlistKey, uri);
        } catch (error) {
          throw new PlaylistRejected(`segment URI "${uri.slice(0, 80)}"`, { cause: error });
        }
        signed.set(uri, (await this.storage.presignMediaGet(key, { ttlSeconds })).url);
      }),
    );
    return serializePlaylist(lines, (uri) => signed.get(uri));
  }

  /** A presigned GET of a re-encoded image (`w750`/`w480` thumbnails, video `poster`). */
  async presignImage(assetId: string, variant: ImageVariant): Promise<SignedUrl> {
    if (!IMAGE_VARIANTS.includes(variant)) throw new RenditionNotFound();
    const asset = await this.readyAsset(
      assetId,
      variant === 'poster' ? 'LECTURE_VIDEO' : 'COURSE_THUMBNAIL',
    );
    const row = (await this.assets.findRenditions(asset.id)).find(
      (r) => r.kind === 'IMAGE' && r.name === variant,
    );
    if (row === undefined) throw new RenditionNotFound();
    return toSignedUrl(
      await this.storage.presignMediaGet(row.objectKey, {
        ttlSeconds: this.settings.values.imageUrlTtlSeconds,
        responseContentType: IMAGE_CONTENT_TYPE,
      }),
    );
  }

  /**
   * A presigned GET of a lecture resource, always `attachment` + `application/octet-stream`
   * (D11). `downloadName` is display-only and RFC 5987-encoded.
   */
  async presignDownload(assetId: string, downloadName: string): Promise<SignedUrl> {
    const asset = await this.readyAsset(assetId, 'LECTURE_RESOURCE');
    if (asset.outputPrefix === null) throw new MediaNotReady();
    return toSignedUrl(
      await this.storage.presignMediaGet(resourceKey(asset.outputPrefix), {
        ttlSeconds: this.settings.values.downloadUrlTtlSeconds,
        responseContentType: DOWNLOAD_CONTENT_TYPE,
        responseContentDisposition: attachmentContentDisposition(downloadName),
      }),
    );
  }

  private async readyAsset(assetId: string, purpose: MediaPurpose): Promise<MediaAssetRecord> {
    const asset = await this.assets.findById(assetId);
    if (asset === null || asset.purged) throw new MediaAssetNotFound();
    if (asset.purpose !== purpose) {
      throw new MediaPurposeMismatch({ expected: purpose, actual: asset.purpose });
    }
    if (asset.status !== 'READY') throw new MediaNotReady();
    return asset;
  }

  private async playlistText(key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const text = await this.storage.readMediaText(key);
    this.cache.set(key, text);
    return text;
  }
}

function toHlsVariant(row: RenditionRecord): HlsVariant[] {
  if (row.kind !== 'HLS_VARIANT' || row.bandwidthBps === null || row.codecs === null) return [];
  return [
    {
      name: row.name,
      bandwidthBps: row.bandwidthBps,
      width: row.width,
      height: row.height,
      codecs: row.codecs,
    },
  ];
}
