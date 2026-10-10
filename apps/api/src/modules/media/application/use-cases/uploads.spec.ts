import { ErrorCode } from '@udemy/contracts';
import { StorageUnavailableError } from '@udemy/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors';
import {
  InvalidMediaField,
  MediaAssetNotFound,
  QuotaExceeded,
  TooManyUploads,
  UnsupportedMediaType,
  UploadIncomplete,
  UploadNotInProgress,
  UploadSizeMismatch,
  UploadTooLarge,
} from '../../domain/media.errors';
import { createMediaHarness, type MediaHarness } from '../testing/media.harness';
import { assetRecord, testSettings } from '../testing/media.fakes';

const MiB = 1024 * 1024;
const OWNER = '00000000-0000-7000-8000-00000000aaaa';
const OTHER = '00000000-0000-7000-8000-00000000cccc';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function video(
  sizeBytes: number,
  overrides: Partial<{ contentType: string; filename: string }> = {},
) {
  return {
    ownerId: OWNER,
    purpose: 'LECTURE_VIDEO' as const,
    filename: overrides.filename ?? 'Intro.mp4',
    contentType: overrides.contentType ?? 'video/mp4',
    sizeBytes,
  };
}

describe('InitiateUpload', () => {
  let h: MediaHarness;
  beforeEach(() => {
    h = createMediaHarness();
  });

  it('creates the S3 upload and an UPLOADING asset with the server part plan', async () => {
    const res = await h.initiate.execute(video(20 * MiB, { contentType: 'Video/MP4' }));

    expect(res).toEqual({
      assetId: expect.stringMatching(UUID_V7),
      partSize: 8 * MiB,
      partCount: 3,
    });
    const asset = h.assets.get(res.assetId);
    expect(asset).toMatchObject({
      ownerId: OWNER,
      status: 'UPLOADING',
      declaredContentType: 'video/mp4',
      declaredSizeBytes: 20 * MiB,
      partSizeBytes: 8 * MiB,
      partCount: 3,
      sourceKey: `uploads/${OWNER}/${res.assetId}/source`,
      s3UploadId: 'upload-1',
      originalFilename: 'Intro.mp4',
    });
    expect([...h.storage.uploads.values()][0]).toMatchObject({
      key: asset.sourceKey,
      contentType: 'video/mp4',
    });
    expect(h.assets.ownerLocks).toEqual([OWNER]);
    expect(h.rateLimiter.hits).toEqual([`initiate:${OWNER}`]);
  });

  it.each([
    ['an unsupported type', video(10, { contentType: 'image/svg+xml' }), UnsupportedMediaType],
    ['a too large file', video(2 * 1024 * MiB), UploadTooLarge],
    ['an empty filename', video(10, { filename: '\u0001 ' }), InvalidMediaField],
  ])('rejects %s before touching Redis or S3', async (_name, input, error) => {
    await expect(h.initiate.execute(input)).rejects.toBeInstanceOf(error);
    expect(h.storage.calls).toEqual([]);
    expect(h.rateLimiter.hits).toEqual([]);
  });

  it('rejects a quota overflow without creating an S3 upload (422 quota_exceeded)', async () => {
    h = createMediaHarness(
      testSettings({ quota: { quotaBytes: 30 * MiB, maxConcurrentUploads: 5 } }),
    );
    await h.initiate.execute(video(20 * MiB));
    await expect(h.initiate.execute(video(10 * MiB + 1))).rejects.toBeInstanceOf(QuotaExceeded);
    expect(h.storage.uploads.size).toBe(1);
    await expect(h.initiate.execute(video(10 * MiB))).resolves.toBeDefined();
  });

  it('limits concurrent UPLOADING assets (429 too_many_uploads)', async () => {
    h = createMediaHarness(
      testSettings({ quota: { quotaBytes: 1024 * MiB, maxConcurrentUploads: 2 } }),
    );
    const first = await h.initiate.execute(video(10));
    await h.initiate.execute(video(10));
    const error = await h.initiate.execute(video(10)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyUploads);
    expect((error as TooManyUploads).code).toBe(ErrorCode.TooManyUploads);
    // Finishing one frees a slot.
    h.assets.setStatus(first.assetId, 'UPLOADED');
    await expect(h.initiate.execute(video(10))).resolves.toBeDefined();
  });

  it('is rate limited per user (429 rate_limited)', async () => {
    h.rateLimiter.limit = 1;
    await h.initiate.execute(video(10));
    await expect(h.initiate.execute(video(10))).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('aborts the multipart upload when the insert fails', async () => {
    h.assets.failNextInsert = new Error('insert failed');
    await expect(h.initiate.execute(video(10))).rejects.toThrow('insert failed');
    expect(h.storage.calls).toEqual([expect.stringMatching(/^create:/), 'abort:upload-1']);
    expect([...h.storage.uploads.values()][0]?.state).toBe('aborted');
  });
});

describe('PresignParts', () => {
  let h: MediaHarness;
  let assetId: string;
  beforeEach(async () => {
    h = createMediaHarness();
    ({ assetId } = await h.initiate.execute(video(20 * MiB)));
  });

  it('signs each requested part with its exact size and the part TTL', async () => {
    const res = await h.presign.execute({ ownerId: OWNER, assetId, partNumbers: [3, 1] });

    expect(res.urls.map((u) => u.partNumber)).toEqual([3, 1]);
    expect(h.storage.presignedParts).toEqual([
      { partNumber: 3, contentLength: 4 * MiB, ttlSeconds: 900 },
      { partNumber: 1, contentLength: 8 * MiB, ttlSeconds: 900 },
    ]);
    expect(res.expiresAt).toBe(new Date(Date.UTC(2026, 9, 10, 13, 15, 0)).toISOString());
    expect(h.rateLimiter.hits).toContain(`parts:${OWNER}`);
  });

  it('answers 404 for another owner, 422 past partCount, 409 once not UPLOADING', async () => {
    await expect(
      h.presign.execute({ ownerId: OTHER, assetId, partNumbers: [1] }),
    ).rejects.toBeInstanceOf(MediaAssetNotFound);
    await expect(
      h.presign.execute({ ownerId: OWNER, assetId, partNumbers: [4] }),
    ).rejects.toBeInstanceOf(InvalidMediaField);
    h.assets.setStatus(assetId, 'ABORTED');
    await expect(
      h.presign.execute({ ownerId: OWNER, assetId, partNumbers: [1] }),
    ).rejects.toBeInstanceOf(UploadNotInProgress);
  });
});

describe('GetUploadStatus', () => {
  it('reports the parts S3 has while UPLOADING, none afterwards', async () => {
    const h = createMediaHarness();
    const { assetId } = await h.initiate.execute(video(20 * MiB));
    h.storage.putPart('upload-1', 2, 8 * MiB);

    expect(await h.status.execute(assetId)).toEqual({
      assetId,
      status: 'UPLOADING',
      partSize: 8 * MiB,
      partCount: 3,
      uploadedParts: [{ partNumber: 2, size: 8 * MiB }],
    });
    h.assets.setStatus(assetId, 'ABORTED');
    expect((await h.status.execute(assetId)).uploadedParts).toEqual([]);
    await expect(h.status.execute(OTHER)).rejects.toBeInstanceOf(MediaAssetNotFound);
  });
});

describe('CompleteUpload', () => {
  let h: MediaHarness;
  let assetId: string;
  let sourceKey: string;

  beforeEach(async () => {
    h = createMediaHarness();
    ({ assetId } = await h.initiate.execute(video(20 * MiB)));
    sourceKey = h.assets.get(assetId).sourceKey;
  });

  const uploadAll = (): void => {
    h.storage.putPart('upload-1', 1, 8 * MiB);
    h.storage.putPart('upload-1', 2, 8 * MiB);
    h.storage.putPart('upload-1', 3, 4 * MiB);
  };

  it('verifies the listed parts, completes, and commits UPLOADED + MediaUploaded', async () => {
    uploadAll();
    const view = await h.complete.execute({ ownerId: OWNER, assetId });

    expect(view).toMatchObject({ id: assetId, status: 'UPLOADED', sizeBytes: 20 * MiB });
    expect(h.storage.calls).toContain('complete:upload-1');
    expect(h.assets.get(assetId).s3UploadId).toBeNull();
    expect(h.events.events).toEqual([
      {
        type: 'MediaUploaded',
        payload: {
          assetId,
          ownerId: OWNER,
          purpose: 'LECTURE_VIDEO',
          declaredContentType: 'video/mp4',
          sizeBytes: 20 * MiB,
          uploadedAt: '2026-10-10T12:30:00.000Z',
        },
      },
    ]);
  });

  it('is idempotent: a second complete returns the state without a second event', async () => {
    uploadAll();
    const first = await h.complete.execute({ ownerId: OWNER, assetId });
    const second = await h.complete.execute({ ownerId: OWNER, assetId });

    expect(second).toEqual(first);
    expect(h.events.events).toHaveLength(1);
  });

  it('answers 409 upload_incomplete with the missing parts', async () => {
    h.storage.putPart('upload-1', 2, 8 * MiB);
    const error = await h.complete.execute({ ownerId: OWNER, assetId }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadIncomplete);
    expect((error as UploadIncomplete).missingParts).toEqual([1, 3]);
    expect(h.assets.get(assetId).status).toBe('UPLOADING');
    expect(h.storage.calls).not.toContain('complete:upload-1');
  });

  it('fails the asset on a part size mismatch (422, MediaFailed, upload aborted)', async () => {
    h.storage.putPart('upload-1', 1, 8 * MiB);
    h.storage.putPart('upload-1', 2, 8 * MiB);
    h.storage.putPart('upload-1', 3, 4 * MiB - 1);

    await expect(h.complete.execute({ ownerId: OWNER, assetId })).rejects.toBeInstanceOf(
      UploadSizeMismatch,
    );
    expect(h.assets.get(assetId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'UPLOAD_SIZE_MISMATCH',
    });
    expect(h.events.events).toEqual([
      {
        type: 'MediaFailed',
        payload: expect.objectContaining({
          assetId,
          failureCode: 'UPLOAD_SIZE_MISMATCH',
          attempts: 0,
        }),
      },
    ]);
    expect(h.storage.calls).toContain('abort:upload-1');
    expect(h.storage.calls).not.toContain('complete:upload-1');
    // Repeating complete answers the (FAILED) state, idempotently.
    await expect(h.complete.execute({ ownerId: OWNER, assetId })).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'UPLOAD_SIZE_MISMATCH',
    });
  });

  it('fails the asset when the completed object has the wrong size', async () => {
    uploadAll();
    // S3 has the object but with a different size (e.g. completed outside our checks).
    h.storage.uploads.get('upload-1')!.state = 'completed';
    h.storage.sources.set(sourceKey, 20 * MiB + 1);

    await expect(h.complete.execute({ ownerId: OWNER, assetId })).rejects.toBeInstanceOf(
      UploadSizeMismatch,
    );
    expect(h.assets.get(assetId).status).toBe('FAILED');
    expect(h.storage.sources.has(sourceKey)).toBe(false);
  });

  it('finishes the DB step when S3 already completed the upload (NoSuchUpload + object)', async () => {
    uploadAll();
    h.storage.uploads.get('upload-1')!.state = 'completed';
    h.storage.sources.set(sourceKey, 20 * MiB);

    await expect(h.complete.execute({ ownerId: OWNER, assetId })).resolves.toMatchObject({
      status: 'UPLOADED',
    });
    expect(h.events.events.map((e) => e.type)).toEqual(['MediaUploaded']);
  });

  it('deletes the completed object when the janitor aborted the asset meanwhile', async () => {
    uploadAll();
    h.assets.beforeMarkUploaded = (id) => h.assets.setStatus(id, 'ABORTED');

    await expect(h.complete.execute({ ownerId: OWNER, assetId })).rejects.toBeInstanceOf(
      UploadNotInProgress,
    );
    expect(h.storage.calls).toContain(`delete:${sourceKey}`);
    expect(h.storage.sources.has(sourceKey)).toBe(false);
    expect(h.events.events).toEqual([]);
  });

  it('answers 409 for an ABORTED asset and 404 for another owner', async () => {
    await expect(h.complete.execute({ ownerId: OTHER, assetId })).rejects.toBeInstanceOf(
      MediaAssetNotFound,
    );
    h.assets.setStatus(assetId, 'ABORTED');
    await expect(h.complete.execute({ ownerId: OWNER, assetId })).rejects.toBeInstanceOf(
      UploadNotInProgress,
    );
  });

  it('answers 409 when S3 has neither the upload nor an object', async () => {
    h.storage.uploads.get('upload-1')!.state = 'aborted';
    await expect(h.complete.execute({ ownerId: OWNER, assetId })).rejects.toBeInstanceOf(
      UploadNotInProgress,
    );
    expect(h.assets.get(assetId).status).toBe('UPLOADING');
  });
});

describe('AbortUpload', () => {
  let h: MediaHarness;
  let assetId: string;
  beforeEach(async () => {
    h = createMediaHarness();
    ({ assetId } = await h.initiate.execute(video(10)));
  });

  it('marks the asset ABORTED, then aborts in S3', async () => {
    await h.abort.execute({ ownerId: OWNER, assetId });
    expect(h.assets.get(assetId)).toMatchObject({ status: 'ABORTED', s3UploadId: null });
    expect(h.storage.calls).toContain('abort:upload-1');
    await expect(h.abort.execute({ ownerId: OWNER, assetId })).rejects.toBeInstanceOf(
      UploadNotInProgress,
    );
  });

  it('succeeds when S3 is down after the commit (the janitor aborts later)', async () => {
    h.storage.abortError = new StorageUnavailableError({ operation: 'abortMultipartUpload' });
    await expect(h.abort.execute({ ownerId: OWNER, assetId })).resolves.toBeUndefined();
    expect(h.assets.get(assetId).status).toBe('ABORTED');
  });

  it('answers 404 for another owner and 409 once completed', async () => {
    await expect(h.abort.execute({ ownerId: OTHER, assetId })).rejects.toBeInstanceOf(
      MediaAssetNotFound,
    );
    h.assets.add(assetRecord({ id: OTHER, ownerId: OWNER, status: 'UPLOADED' }));
    await expect(h.abort.execute({ ownerId: OWNER, assetId: OTHER })).rejects.toBeInstanceOf(
      UploadNotInProgress,
    );
  });
});
