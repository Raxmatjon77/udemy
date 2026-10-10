import { z } from 'zod';
import { ErrorCode } from '../errors/error-code';
import { IsoDateTimeSchema, singleLineText, UuidSchema } from './fields';
import { ProblemDetailsSchema } from './problem-details';

/* ----------------------------------------------------------------------------------------
 * Enums (mirror the `media.*` CHECK constraints, design §6)
 * -------------------------------------------------------------------------------------- */

export const MEDIA_PURPOSES = ['LECTURE_VIDEO', 'LECTURE_RESOURCE', 'COURSE_THUMBNAIL'] as const;
export const MediaPurposeSchema = z.enum(MEDIA_PURPOSES);
export type MediaPurpose = z.infer<typeof MediaPurposeSchema>;

export const MEDIA_ASSET_STATUSES = [
  'UPLOADING',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
  'ABORTED',
] as const;
export const MediaAssetStatusSchema = z.enum(MEDIA_ASSET_STATUSES);
export type MediaAssetStatus = z.infer<typeof MediaAssetStatusSchema>;

/** Terminal states: polling can stop once an asset reaches one of them. */
export const MEDIA_TERMINAL_STATUSES = [
  'READY',
  'FAILED',
  'ABORTED',
] as const satisfies readonly MediaAssetStatus[];

export const MEDIA_FAILURE_CODES = [
  'UPLOAD_SIZE_MISMATCH',
  'INVALID_MEDIA',
  'UNSUPPORTED_MEDIA',
  'TOO_LONG',
  'TOO_LARGE_DIMENSIONS',
  'TRANSCODE_ERROR',
  'TIMEOUT',
  'INTERNAL',
  'CRASHED',
] as const;
export const MediaFailureCodeSchema = z.enum(MEDIA_FAILURE_CODES);
export type MediaFailureCode = z.infer<typeof MediaFailureCodeSchema>;

/**
 * Human-readable explanation of each failure code (design §4 failure classes), for the
 * builder UI and the processing-failed mail. Phrased for the instructor, never technical.
 */
export const MEDIA_FAILURE_LABELS: Readonly<Record<MediaFailureCode, string>> = Object.freeze({
  UPLOAD_SIZE_MISMATCH:
    'The uploaded file does not match the size that was announced. Please upload it again.',
  INVALID_MEDIA: 'The file could not be read as a video, image or document. It may be damaged.',
  UNSUPPORTED_MEDIA: 'This file format is not supported. Please export it in a supported format.',
  TOO_LONG: 'The video is longer than the maximum of 4 hours.',
  TOO_LARGE_DIMENSIONS: 'The video or image dimensions are too large (max 4096×2160 or 40 MP).',
  TRANSCODE_ERROR: 'The file could not be processed. Please try exporting it again.',
  TIMEOUT: 'Processing took too long. Please try a shorter or smaller file.',
  INTERNAL: 'Something went wrong on our side while processing the file. Please try again.',
  CRASHED: 'Processing failed repeatedly. Please try again later or upload a different file.',
});

/**
 * Rendition names (`media.asset_renditions.name` CHECK). HLS variants are `360p`, `480p`,
 * `720p`, `1080p` or `src<height>p` (source-height cap); images are `w750`, `w480`,
 * `poster`, `sprite`.
 */
export const MEDIA_RENDITION_NAME_PATTERN =
  /^(?:360p|480p|720p|1080p|src\d{3,4}p|w750|w480|poster|sprite)$/;
export const MediaRenditionNameSchema = z
  .string()
  .regex(MEDIA_RENDITION_NAME_PATTERN, 'Unknown rendition');

/* ----------------------------------------------------------------------------------------
 * Purpose policy (design §4; the UI pre-validates with it, the api enforces it)
 * -------------------------------------------------------------------------------------- */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface MediaPurposeRule {
  /** Allowed declared `Content-Type`s (lowercase). Real detection happens in the transcoder. */
  readonly contentTypes: readonly string[];
  /**
   * Upper bound on the declared size. For LECTURE_VIDEO this is the default ceiling; the
   * api may lower it with `MEDIA_MAX_VIDEO_BYTES` (1 GiB in dev).
   */
  readonly maxBytes: number;
  /** Pixel-count cap for images (checked before decode by the transcoder). */
  readonly maxPixels: number | null;
}

export const MEDIA_PURPOSE_RULES = Object.freeze({
  LECTURE_VIDEO: Object.freeze({
    contentTypes: Object.freeze(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']),
    maxBytes: 4 * GIB,
    maxPixels: null,
  }),
  COURSE_THUMBNAIL: Object.freeze({
    // No SVG (script) and no GIF (design D11): images are always re-encoded.
    contentTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: 5 * MIB,
    maxPixels: 40_000_000,
  }),
  LECTURE_RESOURCE: Object.freeze({
    contentTypes: Object.freeze(['application/pdf', 'application/zip']),
    maxBytes: 100 * MIB,
    maxPixels: null,
  }),
}) satisfies Readonly<Record<MediaPurpose, MediaPurposeRule>>;

/**
 * Pre-validates an upload against the purpose policy. Returns the problem code the api
 * would answer with (`unsupported_media_type` / `upload_too_large`), or null when allowed.
 * `maxBytesOverride` lets a caller apply a stricter env limit (e.g. dev video size).
 */
export function checkMediaUpload(
  purpose: MediaPurpose,
  contentType: string,
  sizeBytes: number,
  maxBytesOverride?: number,
): typeof ErrorCode.UnsupportedMediaType | typeof ErrorCode.UploadTooLarge | null {
  const rule: MediaPurposeRule = MEDIA_PURPOSE_RULES[purpose];
  if (!rule.contentTypes.includes(contentType.trim().toLowerCase())) {
    return ErrorCode.UnsupportedMediaType;
  }
  const maxBytes = Math.min(rule.maxBytes, maxBytesOverride ?? rule.maxBytes);
  if (sizeBytes > maxBytes) return ErrorCode.UploadTooLarge;
  return null;
}

/** Upload limits shared by the api and the web uploader. */
export const MEDIA_UPLOAD_LIMITS = Object.freeze({
  /** S3 allows at most 10 000 parts (and the `part_count` CHECK mirrors it). */
  maxPartCount: 10_000,
  /** Part numbers per `POST /media/uploads/:assetId/part-urls`. */
  maxPartUrlsPerRequest: 50,
  /** Ids per `GET /media/assets?ids=`. */
  maxAssetIdsPerQuery: 50,
  /** `original_filename` CHECK (1–255). */
  maxFilenameLength: 255,
  /**
   * Shape-level ceiling on `sizeBytes` (S3's 5 TiB object limit). The purpose limits are
   * enforced by the api with `upload_too_large` (422), not by request validation (400).
   */
  maxDeclaredBytes: 5 * 1024 * GIB,
});

/* ----------------------------------------------------------------------------------------
 * Shared views
 * -------------------------------------------------------------------------------------- */

export const AssetIdParamsSchema = z.object({ assetId: UuidSchema });
export type AssetIdParams = z.output<typeof AssetIdParamsSchema>;

/** `GET /media/assets/:assetId`, and embedded wherever the builder shows an asset. */
export const AssetViewSchema = z.object({
  id: UuidSchema,
  ownerId: UuidSchema,
  purpose: MediaPurposeSchema,
  status: MediaAssetStatusSchema,
  /** Display only (sanitized by the api). */
  originalFilename: z.string(),
  sizeBytes: z.number().int().min(1),
  /** Transcode progress while PROCESSING, else null. */
  progressPct: z.number().int().min(0).max(100).nullable(),
  /** Set iff status is FAILED. */
  failureCode: MediaFailureCodeSchema.nullable(),
  /** Videos only, once READY. */
  durationSeconds: z.number().int().min(0).nullable(),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  renditions: z.array(MediaRenditionNameSchema),
  /** The asset was purged by the janitor (no usages past the grace period). */
  purged: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type AssetView = z.infer<typeof AssetViewSchema>;

/** A presigned capability URL (thumbnail, download). Never log it. */
export const SignedUrlSchema = z.object({
  url: z.string(),
  expiresAt: IsoDateTimeSchema,
});
export type SignedUrl = z.infer<typeof SignedUrlSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /media/uploads -> 201 InitiateUploadResponse
 * -------------------------------------------------------------------------------------- */

/** A MIME type, lowercased (`type/subtype`, no parameters). */
const ContentTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, 'Invalid content type');

/**
 * Only the shape is validated here. Type and size against the purpose policy are domain
 * errors (422 `unsupported_media_type` / `upload_too_large`); use `checkMediaUpload` to
 * pre-validate in the UI.
 */
export const InitiateUploadRequestSchema = z.object({
  purpose: MediaPurposeSchema,
  filename: singleLineText(1, MEDIA_UPLOAD_LIMITS.maxFilenameLength),
  contentType: ContentTypeSchema,
  sizeBytes: z.number().int().min(1).max(MEDIA_UPLOAD_LIMITS.maxDeclaredBytes),
});
export type InitiateUploadRequest = z.output<typeof InitiateUploadRequestSchema>;

export const InitiateUploadResponseSchema = z.object({
  assetId: UuidSchema,
  /** Every part but the last has exactly this size. */
  partSize: z.number().int().min(1),
  partCount: z.number().int().min(1).max(MEDIA_UPLOAD_LIMITS.maxPartCount),
});
export type InitiateUploadResponse = z.infer<typeof InitiateUploadResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /media/uploads/:assetId -> 200 UploadStatus (resume)
 * -------------------------------------------------------------------------------------- */

export const UploadedPartSchema = z.object({
  partNumber: z.number().int().min(1).max(MEDIA_UPLOAD_LIMITS.maxPartCount),
  size: z.number().int().min(0),
});
export type UploadedPart = z.infer<typeof UploadedPartSchema>;

export const UploadStatusSchema = z.object({
  assetId: UuidSchema,
  status: MediaAssetStatusSchema,
  partSize: z.number().int().min(1),
  partCount: z.number().int().min(1).max(MEDIA_UPLOAD_LIMITS.maxPartCount),
  /** From S3 `ListParts`; empty once the upload left UPLOADING. */
  uploadedParts: z.array(UploadedPartSchema),
});
export type UploadStatus = z.infer<typeof UploadStatusSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /media/uploads/:assetId/part-urls -> 200 PresignPartsResponse
 * -------------------------------------------------------------------------------------- */

/** 1–50 distinct part numbers; each must also be ≤ the asset's `partCount` (api, 422). */
export const PresignPartsRequestSchema = z.object({
  partNumbers: z
    .array(z.number().int().min(1).max(MEDIA_UPLOAD_LIMITS.maxPartCount))
    .min(1)
    .max(MEDIA_UPLOAD_LIMITS.maxPartUrlsPerRequest)
    .refine((numbers) => new Set(numbers).size === numbers.length, {
      message: 'Part numbers must be unique',
    }),
});
export type PresignPartsRequest = z.output<typeof PresignPartsRequestSchema>;

/** `PUT` each part to its URL with exactly the signed `Content-Length`, `credentials: 'omit'`. */
export const PresignPartsResponseSchema = z.object({
  urls: z.array(
    z.object({
      partNumber: z.number().int().min(1).max(MEDIA_UPLOAD_LIMITS.maxPartCount),
      url: z.string(),
    }),
  ),
  expiresAt: IsoDateTimeSchema,
});
export type PresignPartsResponse = z.infer<typeof PresignPartsResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /media/uploads/:assetId/complete -> 200 AssetView (idempotent)
 * DELETE /media/uploads/:assetId -> 204
 * -------------------------------------------------------------------------------------- */

export const CompleteUploadRequestSchema = z.object({});
export type CompleteUploadRequest = z.output<typeof CompleteUploadRequestSchema>;

export const CompleteUploadResponseSchema = AssetViewSchema;
export type CompleteUploadResponse = AssetView;

/** 409 `upload_incomplete`: the part numbers S3 does not have (with the expected size). */
export const UploadIncompleteProblemSchema = ProblemDetailsSchema.extend({
  code: z.literal(ErrorCode.UploadIncomplete),
  missingParts: z.array(z.number().int().min(1).max(MEDIA_UPLOAD_LIMITS.maxPartCount)),
});
export type UploadIncompleteProblem = z.infer<typeof UploadIncompleteProblemSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /media/assets?ids=a,b,c -> 200 { items: AssetView[] } (foreign ids are omitted)
 * -------------------------------------------------------------------------------------- */

/** Accepts `?ids=a,b,c` and repeated `?ids=a&ids=b`. */
function splitCommaList(value: unknown): unknown {
  if (typeof value === 'string') return value === '' ? [] : value.split(',');
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => (typeof item === 'string' ? item.split(',') : [item]));
  }
  return value;
}

export const AssetsQuerySchema = z.object({
  ids: z.preprocess(
    splitCommaList,
    z
      .array(UuidSchema)
      .min(1)
      .max(MEDIA_UPLOAD_LIMITS.maxAssetIdsPerQuery)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' }),
  ),
});
export type AssetsQuery = z.output<typeof AssetsQuerySchema>;

export const AssetListResponseSchema = z.object({ items: z.array(AssetViewSchema) });
export type AssetListResponse = z.infer<typeof AssetListResponseSchema>;
