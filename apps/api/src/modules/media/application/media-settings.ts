import type { PurposeByteLimits } from '../domain/purpose-policy';
import type { UploadQuotaLimits } from '../domain/upload-quota';

/**
 * Media configuration, resolved once from the validated env (`MEDIA_*`, design §4/§9).
 * A plain value object so use cases and their unit tests can build one without Nest.
 */
export class MediaSettings {
  constructor(
    readonly values: {
      /** `MEDIA_PART_URL_TTL_S`: presigned UploadPart PUTs. */
      readonly partUrlTtlSeconds: number;
      /** `MEDIA_PLAYBACK_URL_TTL_S`: presigned HLS segment GETs. */
      readonly playbackUrlTtlSeconds: number;
      /** `MEDIA_IMAGE_URL_TTL_S`: thumbnails and posters. */
      readonly imageUrlTtlSeconds: number;
      /** `MEDIA_DOWNLOAD_URL_TTL_S`: lecture resources (attachment). */
      readonly downloadUrlTtlSeconds: number;
      /** `MEDIA_MAX_{VIDEO,IMAGE,RESOURCE}_BYTES`. */
      readonly maxBytes: PurposeByteLimits;
      readonly quota: UploadQuotaLimits;
    },
  ) {}
}

/** Per-user Redis rate limits (design §9). */
export const MEDIA_RATE_LIMITS = Object.freeze({
  /** `rl:media:initiate:u:{uid}`: 30 InitiateUploads per hour. */
  initiate: { limit: 30, windowMs: 60 * 60 * 1000 },
  /** `rl:media:parts:u:{uid}`: 1200 part-URL requests per hour. */
  presignParts: { limit: 1200, windowMs: 60 * 60 * 1000 },
});
