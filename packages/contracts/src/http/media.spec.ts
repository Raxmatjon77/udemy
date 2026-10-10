import { describe, expect, it } from 'vitest';
import {
  AssetsQuerySchema,
  AssetViewSchema,
  checkMediaUpload,
  CompleteUploadRequestSchema,
  InitiateUploadRequestSchema,
  InitiateUploadResponseSchema,
  MEDIA_FAILURE_CODES,
  MEDIA_FAILURE_LABELS,
  MEDIA_PURPOSE_RULES,
  MEDIA_PURPOSES,
  MediaRenditionNameSchema,
  PresignPartsRequestSchema,
  PresignPartsResponseSchema,
  UploadIncompleteProblemSchema,
  UploadStatusSchema,
} from './media';

const id = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c01';
const id2 = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c02';
const at = '2026-10-10T12:00:00.000Z';
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('MEDIA_PURPOSE_RULES', () => {
  it('covers every purpose with the design §4 policy', () => {
    expect(Object.keys(MEDIA_PURPOSE_RULES).sort()).toEqual([...MEDIA_PURPOSES].sort());
    expect(MEDIA_PURPOSE_RULES.LECTURE_VIDEO.contentTypes).toEqual([
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/x-matroska',
    ]);
    expect(MEDIA_PURPOSE_RULES.LECTURE_VIDEO.maxBytes).toBe(4 * GIB);
    expect(MEDIA_PURPOSE_RULES.COURSE_THUMBNAIL.contentTypes).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    expect(MEDIA_PURPOSE_RULES.COURSE_THUMBNAIL.maxBytes).toBe(5 * MIB);
    expect(MEDIA_PURPOSE_RULES.COURSE_THUMBNAIL.maxPixels).toBe(40_000_000);
    expect(MEDIA_PURPOSE_RULES.LECTURE_RESOURCE.contentTypes).toEqual([
      'application/pdf',
      'application/zip',
    ]);
    expect(MEDIA_PURPOSE_RULES.LECTURE_RESOURCE.maxBytes).toBe(100 * MIB);
    expect(Object.isFrozen(MEDIA_PURPOSE_RULES.LECTURE_VIDEO.contentTypes)).toBe(true);
  });

  it('never allows SVG or GIF thumbnails', () => {
    expect(checkMediaUpload('COURSE_THUMBNAIL', 'image/svg+xml', 100)).toBe(
      'unsupported_media_type',
    );
    expect(checkMediaUpload('COURSE_THUMBNAIL', 'image/gif', 100)).toBe('unsupported_media_type');
  });

  it('checkMediaUpload returns the api problem code', () => {
    expect(checkMediaUpload('LECTURE_VIDEO', 'video/mp4', 4 * GIB)).toBeNull();
    expect(checkMediaUpload('LECTURE_VIDEO', ' Video/MP4 ', 1)).toBeNull();
    expect(checkMediaUpload('LECTURE_VIDEO', 'video/mp4', 4 * GIB + 1)).toBe('upload_too_large');
    expect(checkMediaUpload('LECTURE_VIDEO', 'video/mp4', 2 * GIB, GIB)).toBe('upload_too_large');
    expect(checkMediaUpload('LECTURE_VIDEO', 'video/mp4', 8 * GIB, 16 * GIB)).toBe(
      'upload_too_large',
    );
    expect(checkMediaUpload('LECTURE_VIDEO', 'application/pdf', 1)).toBe('unsupported_media_type');
    expect(checkMediaUpload('COURSE_THUMBNAIL', 'image/png', 5 * MIB)).toBeNull();
    expect(checkMediaUpload('COURSE_THUMBNAIL', 'image/png', 5 * MIB + 1)).toBe('upload_too_large');
    expect(checkMediaUpload('LECTURE_RESOURCE', 'application/zip', 100 * MIB)).toBeNull();
    expect(checkMediaUpload('LECTURE_RESOURCE', 'application/zip', 100 * MIB + 1)).toBe(
      'upload_too_large',
    );
  });

  it('labels every failure code', () => {
    expect(Object.keys(MEDIA_FAILURE_LABELS).sort()).toEqual([...MEDIA_FAILURE_CODES].sort());
    for (const label of Object.values(MEDIA_FAILURE_LABELS))
      expect(label.length).toBeGreaterThan(10);
  });
});

describe('InitiateUploadRequestSchema', () => {
  const body = {
    purpose: 'LECTURE_VIDEO',
    filename: 'Lecture 1.mp4',
    contentType: 'video/mp4',
    sizeBytes: 123_456_789,
  };
  const ok = (value: unknown) => InitiateUploadRequestSchema.safeParse(value).success;

  it('accepts a valid body and normalises the content type and filename', () => {
    expect(
      InitiateUploadRequestSchema.parse({
        ...body,
        filename: '  Lecture 1.mp4 ',
        contentType: ' Video/MP4',
      }),
    ).toEqual(body);
  });

  it('validates shape only; the purpose policy is a domain error', () => {
    // Wrong type for the purpose is still a valid shape (422 comes from the api).
    expect(ok({ ...body, contentType: 'application/pdf' })).toBe(true);
    expect(ok({ ...body, sizeBytes: 50 * GIB })).toBe(true);
  });

  it('rejects boundary violations', () => {
    expect(ok({ ...body, purpose: 'USER_AVATAR' })).toBe(false);
    expect(ok({ ...body, filename: '' })).toBe(false);
    expect(ok({ ...body, filename: '   ' })).toBe(false);
    expect(ok({ ...body, filename: 'f'.repeat(255) })).toBe(true);
    expect(ok({ ...body, filename: 'f'.repeat(256) })).toBe(false);
    expect(ok({ ...body, filename: 'a\u0000b.mp4' })).toBe(false);
    expect(ok({ ...body, filename: 'a\nb.mp4' })).toBe(false);
    expect(ok({ ...body, contentType: 'video' })).toBe(false);
    expect(ok({ ...body, contentType: 'video/mp4; codecs=avc1' })).toBe(false);
    expect(ok({ ...body, sizeBytes: 0 })).toBe(false);
    expect(ok({ ...body, sizeBytes: 1.5 })).toBe(false);
    expect(ok({ ...body, sizeBytes: '100' })).toBe(false);
    expect(ok({ ...body, sizeBytes: 6 * 1024 * GIB })).toBe(false);
  });

  it('describes the response', () => {
    expect(
      InitiateUploadResponseSchema.safeParse({ assetId: id, partSize: 8 * MIB, partCount: 15 })
        .success,
    ).toBe(true);
    expect(
      InitiateUploadResponseSchema.safeParse({ assetId: id, partSize: 8 * MIB, partCount: 10_001 })
        .success,
    ).toBe(false);
  });
});

describe('part URLs and completion', () => {
  const ok = (value: unknown) => PresignPartsRequestSchema.safeParse(value).success;

  it('accepts 1–50 distinct part numbers', () => {
    expect(ok({ partNumbers: [1] })).toBe(true);
    expect(ok({ partNumbers: Array.from({ length: 50 }, (_, i) => i + 1) })).toBe(true);
    expect(ok({ partNumbers: Array.from({ length: 51 }, (_, i) => i + 1) })).toBe(false);
    expect(ok({ partNumbers: [] })).toBe(false);
    expect(ok({ partNumbers: [0] })).toBe(false);
    expect(ok({ partNumbers: [10_001] })).toBe(false);
    expect(ok({ partNumbers: [1, 1] })).toBe(false);
    expect(ok({ partNumbers: [1.5] })).toBe(false);
  });

  it('describes the presign, status and incomplete responses', () => {
    expect(
      PresignPartsResponseSchema.safeParse({
        urls: [{ partNumber: 1, url: 'http://127.0.0.1:9000/udemy-uploads/x?X-Amz-Signature=y' }],
        expiresAt: at,
      }).success,
    ).toBe(true);
    expect(
      UploadStatusSchema.safeParse({
        assetId: id,
        status: 'UPLOADING',
        partSize: 8 * MIB,
        partCount: 3,
        uploadedParts: [{ partNumber: 1, size: 8 * MIB }],
      }).success,
    ).toBe(true);
    const problem = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'upload_incomplete',
      missingParts: [2, 3],
    };
    expect(UploadIncompleteProblemSchema.parse(problem)).toEqual(problem);
    expect(UploadIncompleteProblemSchema.safeParse({ ...problem, code: 'conflict' }).success).toBe(
      false,
    );
    expect(CompleteUploadRequestSchema.parse({})).toEqual({});
  });
});

describe('assets', () => {
  const asset = {
    id,
    ownerId: id2,
    purpose: 'LECTURE_VIDEO',
    status: 'READY',
    originalFilename: 'intro.mp4',
    sizeBytes: 1000,
    progressPct: null,
    failureCode: null,
    durationSeconds: 305,
    width: 1280,
    height: 720,
    renditions: ['360p', '720p', 'src1440p', 'poster', 'sprite'],
    purged: false,
    createdAt: at,
  };

  it('AssetView accepts valid views and rejects bad values', () => {
    expect(AssetViewSchema.parse(asset)).toEqual(asset);
    expect(
      AssetViewSchema.safeParse({
        ...asset,
        status: 'FAILED',
        failureCode: 'TIMEOUT',
        durationSeconds: null,
      }).success,
    ).toBe(true);
    expect(AssetViewSchema.safeParse({ ...asset, progressPct: 101 }).success).toBe(false);
    expect(AssetViewSchema.safeParse({ ...asset, failureCode: 'OOM' }).success).toBe(false);
    expect(AssetViewSchema.safeParse({ ...asset, status: 'DONE' }).success).toBe(false);
  });

  it('rendition names follow the DB CHECK', () => {
    for (const name of ['360p', '480p', '720p', '1080p', 'src540p', 'src2160p', 'w750', 'w480']) {
      expect(MediaRenditionNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of ['240p', 'src12p', 'src12345p', '../720p', '720p.m3u8', 'w1000', '']) {
      expect(MediaRenditionNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('AssetsQuery splits comma lists and repeated params', () => {
    expect(AssetsQuerySchema.parse({ ids: `${id},${id2}` })).toEqual({ ids: [id, id2] });
    expect(AssetsQuerySchema.parse({ ids: [id, id2] })).toEqual({ ids: [id, id2] });
    expect(AssetsQuerySchema.safeParse({ ids: '' }).success).toBe(false);
    expect(AssetsQuerySchema.safeParse({}).success).toBe(false);
    expect(AssetsQuerySchema.safeParse({ ids: `${id},${id}` }).success).toBe(false);
    expect(AssetsQuerySchema.safeParse({ ids: `${id},nope` }).success).toBe(false);
    const fiftyOne = Array.from(
      { length: 51 },
      (_, i) => `0199c9a1-7d2e-7c4a-9b1e-${String(i).padStart(12, '0')}`,
    );
    expect(AssetsQuerySchema.safeParse({ ids: fiftyOne.slice(0, 50).join(',') }).success).toBe(
      true,
    );
    expect(AssetsQuerySchema.safeParse({ ids: fiftyOne.join(',') }).success).toBe(false);
  });
});
