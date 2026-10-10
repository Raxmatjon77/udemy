import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { attachmentContentDisposition } from './content-disposition';
import { StorageEntityTooLargeError, StorageNotFoundError, StorageUsageError } from './errors';
import { uploadSourceKey } from './keys';
import { checkUploadedParts, MiB, partRange, planParts } from './part-plan';
import { useIntegrationS3 } from './testing/it-s3.mjs';

const s3 = useIntegrationS3();

/** A source key in the design layout, under this file's `it-<random>/` prefix. */
function sourceKey(): string {
  return `${s3.prefix}${uploadSourceKey(randomUUID(), randomUUID())}`;
}

function bytes(size: number, seed: number): Buffer {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) buffer[i] = (i / 4096 + seed) % 251;
  return buffer;
}

async function putPart(url: string, body: Buffer): Promise<Response> {
  return fetch(url, { method: 'PUT', body, credentials: 'omit' });
}

describe('multipart upload', () => {
  it('round trip: create, presign 2 parts, PUT, list, complete, head', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { storage } = s3;
    const key = sourceKey();
    const plan = planParts(5 * MiB + 1234, { minPartSize: 5 * MiB });
    expect(plan.partCount).toBe(2);
    const file = bytes(plan.sizeBytes, 7);

    const { uploadId } = await storage.createMultipartUpload({
      bucket: 'uploads',
      key,
      contentType: 'video/mp4',
    });

    // Upload the parts out of order: S3 orders them by number.
    for (const n of [2, 1]) {
      const range = partRange(plan, n);
      const signed = await storage.presignUploadPart({
        bucket: 'uploads',
        key,
        uploadId,
        partNumber: n,
        contentLength: range.size,
        ttlSeconds: 900,
      });
      expect(new URL(signed.url).host).toBe(new URL(s3.config.publicEndpoint).host);
      const res = await putPart(signed.url, file.subarray(range.start, range.end));
      expect(res.status).toBe(200);
    }

    const parts = await storage.listParts({ bucket: 'uploads', key, uploadId, pageSize: 1 });
    expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
      [1, 5 * MiB],
      [2, 1234],
    ]);
    expect(checkUploadedParts(plan, parts).ok).toBe(true);

    // A directory-style prefix (MinIO alone would only match an exact key; see the method doc).
    const uploads: { key: string; uploadId: string }[] = [];
    for await (const u of storage.listMultipartUploads({ bucket: 'uploads', prefix: s3.prefix })) {
      uploads.push({ key: u.key, uploadId: u.uploadId });
    }
    expect(uploads).toContainEqual({ key, uploadId });
    for (const u of uploads) expect(u.key.startsWith(s3.prefix)).toBe(true);

    await storage.completeMultipartUpload({ bucket: 'uploads', key, uploadId, parts, plan });

    const head = await storage.headObject({ bucket: 'uploads', key });
    expect(head?.size).toBe(plan.sizeBytes);
    expect(head?.contentType).toBe('video/mp4');
    expect(head?.contentDisposition).toBe('attachment');

    const firstBytes = await storage.getObjectRange({ bucket: 'uploads', key, start: 0, end: 16 });
    expect(firstBytes.equals(file.subarray(0, 16))).toBe(true);
    const tail = await storage.getObjectRange({
      bucket: 'uploads',
      key,
      start: plan.sizeBytes - 10,
      end: plan.sizeBytes,
    });
    expect(tail.equals(file.subarray(plan.sizeBytes - 10))).toBe(true);

    // Completed: the upload id is gone (CompleteUpload's idempotent path relies on NoSuchUpload).
    const again = await storage
      .completeMultipartUpload({ bucket: 'uploads', key, uploadId, parts })
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(StorageNotFoundError);
    expect((again as StorageNotFoundError).s3Code).toBe('NoSuchUpload');
  });

  it('abort is idempotent and removes the upload', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { storage } = s3;
    const key = sourceKey();
    const { uploadId } = await storage.createMultipartUpload({
      bucket: 'uploads',
      key,
      contentType: 'application/pdf',
    });
    const signed = await storage.presignUploadPart({
      bucket: 'uploads',
      key,
      uploadId,
      partNumber: 1,
      contentLength: 100,
      ttlSeconds: 60,
    });
    expect((await putPart(signed.url, bytes(100, 1))).status).toBe(200);

    await storage.abortMultipartUpload({ bucket: 'uploads', key, uploadId });
    // Idempotent: a repeated abort (MinIO: 204) and an unknown id (404 NoSuchUpload) both resolve.
    await storage.abortMultipartUpload({ bucket: 'uploads', key, uploadId });
    await storage.abortMultipartUpload({ bucket: 'uploads', key, uploadId: 'never-issued' });

    const listed = await storage.listParts({ bucket: 'uploads', key, uploadId }).catch((e) => e);
    expect(listed).toBeInstanceOf(StorageNotFoundError);
    expect((listed as StorageNotFoundError).s3Code).toBe('NoSuchUpload');
    for await (const u of storage.listMultipartUploads({ bucket: 'uploads', prefix: s3.prefix })) {
      expect(u.uploadId).not.toBe(uploadId);
    }
    expect(await storage.headObject({ bucket: 'uploads', key })).toBeNull();
  });

  it('refuses to complete parts that do not match the plan, before calling S3', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { storage } = s3;
    const key = sourceKey();
    const plan = planParts(5 * MiB + 1, { minPartSize: 5 * MiB });
    const { uploadId } = await storage.createMultipartUpload({
      bucket: 'uploads',
      key,
      contentType: 'video/mp4',
    });
    const range = partRange(plan, 1);
    const signed = await storage.presignUploadPart({
      bucket: 'uploads',
      key,
      uploadId,
      partNumber: 1,
      contentLength: range.size,
      ttlSeconds: 60,
    });
    expect((await putPart(signed.url, bytes(range.size, 3))).status).toBe(200);
    const parts = await storage.listParts({ bucket: 'uploads', key, uploadId });
    expect(checkUploadedParts(plan, parts).missing).toEqual([2]);
    await expect(
      storage.completeMultipartUpload({ bucket: 'uploads', key, uploadId, parts, plan }),
    ).rejects.toThrow(StorageUsageError);
    // Still in progress; afterAll aborts it.
    expect(await storage.listParts({ bucket: 'uploads', key, uploadId })).toHaveLength(1);
  });
});

describe('presigned GET', () => {
  it('serves a media object as an attachment with overridden content type', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { storage } = s3;
    const key = `${s3.prefix}assets/${randomUUID()}/a1/resource`;
    await storage.putObject({
      bucket: 'media',
      key,
      body: '%PDF-1.4 fake',
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=0',
    });
    const disposition = attachmentContentDisposition('Résumé "v2".pdf');
    const signed = await storage.presignGet({
      bucket: 'media',
      key,
      ttlSeconds: 300,
      responseContentType: 'application/octet-stream',
      responseContentDisposition: disposition,
    });
    expect(new URL(signed.url).host).toBe(new URL(s3.config.publicEndpoint).host);

    const res = await fetch(signed.url, { credentials: 'omit' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(disposition);
    expect(await res.text()).toBe('%PDF-1.4 fake');

    // The signature binds the host: the same URL on another host name is refused.
    const other = new URL(signed.url);
    other.hostname = other.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
    const swapped = await fetch(other);
    expect(swapped.status).toBe(403);
    expect(await swapped.text()).toContain('<Code>SignatureDoesNotMatch</Code>');
  });

  it('refuses to presign a GET on the uploads bucket', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    await expect(
      s3.storage.presignGet({ bucket: 'uploads' as 'media', key: sourceKey(), ttlSeconds: 60 }),
    ).rejects.toThrow(StorageUsageError);
  });
});

describe('objects', () => {
  it('put / text / conditional put / stream / copy / list / delete', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { storage } = s3;
    const base = `${s3.prefix}objects/`;
    const playlist = `${base}hls/360p/index.m3u8`;
    const body = '#EXTM3U\n#EXT-X-VERSION:3\nseg_00000.ts\n';

    await storage.putObject({
      bucket: 'media',
      key: playlist,
      body,
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(await storage.getObjectText({ bucket: 'media', key: playlist })).toBe(body);
    await expect(
      storage.getObjectText({ bucket: 'media', key: playlist, maxBytes: 10 }),
    ).rejects.toThrow(StorageEntityTooLargeError);
    const head = await storage.headObject({ bucket: 'media', key: playlist });
    expect(head).toMatchObject({
      size: Buffer.byteLength(body),
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    // Stream body with a known length, and a file.
    await storage.putObject({
      bucket: 'media',
      key: `${base}stream.txt`,
      body: Readable.from([Buffer.from('hello '), Buffer.from('world')]),
      contentLength: 11,
      contentType: 'text/plain',
    });
    const dir = await mkdtemp(join(tmpdir(), 'udemy-storage-it-'));
    try {
      await writeFile(join(dir, 'seg.ts'), bytes(70_000, 9));
      await storage.putFile({
        bucket: 'media',
        key: `${base}hls/360p/seg_00000.ts`,
        filePath: join(dir, 'seg.ts'),
        contentType: 'video/mp2t',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const streamed = await storage.getObjectStream({ bucket: 'media', key: `${base}stream.txt` });
    expect(await text(streamed.body)).toBe('hello world');
    const ranged = await storage.getObjectStream({
      bucket: 'media',
      key: `${base}stream.txt`,
      range: { start: 6, end: 11 },
    });
    expect(await text(ranged.body)).toBe('world');

    // Copy uploads -> media with replaced metadata (resource pipeline).
    const source = `${s3.prefix}copy/source`;
    await storage.putObject({
      bucket: 'uploads',
      key: source,
      body: 'PK\x03\x04zip',
      contentType: 'application/zip',
    });
    await storage.copyObject({
      from: { bucket: 'uploads', key: source },
      to: { bucket: 'media', key: `${base}resource` },
      write: { contentType: 'application/octet-stream', contentDisposition: 'attachment' },
    });
    expect(await storage.headObject({ bucket: 'media', key: `${base}resource` })).toMatchObject({
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
      size: 7,
    });

    // Missing objects.
    expect(await storage.headObject({ bucket: 'media', key: `${base}missing` })).toBeNull();
    const missing = await storage
      .getObjectStream({ bucket: 'media', key: `${base}missing` })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(StorageNotFoundError);
    expect((missing as StorageNotFoundError).s3Code).toBe('NoSuchKey');

    // Paginated listing.
    const listed: string[] = [];
    for await (const o of storage.listObjects({ bucket: 'media', prefix: base, pageSize: 2 })) {
      listed.push(o.key.slice(base.length));
    }
    expect(listed).toEqual([
      'hls/360p/index.m3u8',
      'hls/360p/seg_00000.ts',
      'resource',
      'stream.txt',
    ]);

    // Batch delete (a missing key is not an error), then prefix delete.
    const result = await storage.deleteObjects({
      bucket: 'media',
      keys: [`${base}stream.txt`, `${base}never-existed`],
    });
    expect(result.errors).toEqual([]);
    await storage.deleteObject({ bucket: 'uploads', key: source });
    expect(await storage.headObject({ bucket: 'uploads', key: source })).toBeNull();
    expect(await storage.deletePrefix({ bucket: 'media', prefix: base })).toBe(3);
    for await (const o of storage.listObjects({ bucket: 'media', prefix: base })) {
      throw new Error(`left behind: ${o.key}`);
    }
    await expect(
      storage.deletePrefix({ bucket: 'media', prefix: s3.prefix.slice(0, -1) }),
    ).rejects.toThrow(StorageUsageError);
  });

  it('deletes more than one DeleteObjects batch', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { storage } = s3;
    const base = `${s3.prefix}many/`;
    const keys = Array.from({ length: 1005 }, (_, i) => `${base}${String(i).padStart(4, '0')}`);
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(
        keys
          .slice(i, i + 50)
          .map((key) =>
            storage.putObject({ bucket: 'media', key, body: '', contentType: 'text/plain' }),
          ),
      );
    }
    const result = await storage.deleteObjects({ bucket: 'media', keys });
    expect(result).toEqual({ deleted: 1005, errors: [] });
    for await (const o of storage.listObjects({ bucket: 'media', prefix: base })) {
      throw new Error(`left behind: ${o.key}`);
    }
  }, 120_000);
});
