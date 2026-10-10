import { randomUUID } from 'node:crypto';
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uploadSourceKey } from './keys';
import { MiB } from './part-plan';
import { createS3Clients, destroyS3Clients, type S3Clients } from './s3-clients';
import { useIntegrationS3 } from './testing/it-s3';

/**
 * P2-T5 spike (design §11 "Risks to verify early"), pinned as regression tests against the real
 * MinIO (bitnamilegacy/minio:2025.7.23 in dev):
 *
 * 1. A presigned UploadPart with `content-length` in SignedHeaders is enforced: a body of N+1 or
 *    N-1 bytes is refused with 403 SignatureDoesNotMatch, a chunked body (no Content-Length) with
 *    411 MissingContentLength. Without the signed header the same URL accepts any size.
 * 2. CORS (`MINIO_API_CORS_ALLOW_ORIGIN`) answers the preflight for an allowed web origin, exposes
 *    ETag on the actual PUT, and gives an unlisted origin no CORS headers.
 * 3. Path-style URLs signed for S3_PUBLIC_ENDPOINT (127.0.0.1) work from the host; the same URL on
 *    another host name fails, so browser URLs must be signed for the browser's host.
 */
const s3 = useIntegrationS3();
const N = 5 * MiB;
const ALLOWED_ORIGIN = 'http://localhost:3001';

let clients: S3Clients | undefined;
beforeAll(() => {
  clients = createS3Clients(s3.config);
});
afterAll(() => {
  if (clients !== undefined) destroyS3Clients(clients);
});

async function s3Code(res: Response): Promise<string | undefined> {
  return /<Code>([^<]+)<\/Code>/.exec(await res.text())?.[1];
}

async function startUpload(): Promise<{ key: string; uploadId: string }> {
  const key = `${s3.prefix}${uploadSourceKey(randomUUID(), randomUUID())}`;
  const { uploadId } = await s3.storage.createMultipartUpload({
    bucket: 'uploads',
    key,
    contentType: 'video/mp4',
  });
  return { key, uploadId };
}

async function partUrl(key: string, uploadId: string, partNumber: number): Promise<string> {
  const signed = await s3.storage.presignUploadPart({
    bucket: 'uploads',
    key,
    uploadId,
    partNumber,
    contentLength: N,
    ttlSeconds: 900,
  });
  return signed.url;
}

describe('spike 1: signed Content-Length on presigned UploadPart', () => {
  it('MinIO rejects N+1, N-1 and chunked bodies, and accepts exactly N', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { key, uploadId } = await startUpload();
    const url = await partUrl(key, uploadId, 1);
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');

    const over = await fetch(url, { method: 'PUT', body: Buffer.alloc(N + 1, 1) });
    expect([over.status, await s3Code(over)]).toEqual([403, 'SignatureDoesNotMatch']);

    const under = await fetch(url, { method: 'PUT', body: Buffer.alloc(N - 1, 1) });
    expect([under.status, await s3Code(under)]).toEqual([403, 'SignatureDoesNotMatch']);

    const chunked = await fetch(url, {
      method: 'PUT',
      body: new ReadableStream({
        start(controller): void {
          controller.enqueue(new Uint8Array(N));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect([chunked.status, await s3Code(chunked)]).toEqual([411, 'MissingContentLength']);

    // A browser adds an unsigned Content-Type for a typed Blob/File: still accepted.
    const exact = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(N, 2),
      headers: { 'content-type': 'video/mp4' },
    });
    expect(exact.status).toBe(200);

    const parts = await s3.storage.listParts({ bucket: 'uploads', key, uploadId });
    expect(parts.map((p) => [p.partNumber, p.size])).toEqual([[1, N]]);
  });

  it('control: WITHOUT content-length in SignedHeaders, MinIO accepts any size', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    if (clients === undefined) throw new Error('clients not created');
    const { key, uploadId } = await startUpload();
    const unsigned = await getSignedUrl(
      clients.public,
      new UploadPartCommand({
        Bucket: s3.config.buckets.uploads,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        ContentLength: 10,
      }),
      { expiresIn: 60, unsignableHeaders: new Set(['content-length']) },
    );
    expect(new URL(unsigned).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    const res = await fetch(unsigned, { method: 'PUT', body: Buffer.alloc(N + 7, 1) });
    expect(res.status).toBe(200);
    const parts = await s3.storage.listParts({ bucket: 'uploads', key, uploadId });
    expect(parts[0]?.size).toBe(N + 7); // 10 planned, N+7 stored: why the header must be signed
  });
});

describe('spike 2: CORS for direct browser PUTs', () => {
  it('answers the preflight for an allowed origin and exposes ETag on the PUT', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { key, uploadId } = await startUpload();
    const url = await partUrl(key, uploadId, 1);

    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'content-type',
    );

    const put = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(N, 4),
      headers: { Origin: ALLOWED_ORIGIN, 'content-type': 'video/mp4' },
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(put.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('etag');
  });

  it('gives an unlisted origin no CORS headers (the browser blocks it)', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { key, uploadId } = await startUpload();
    const url = await partUrl(key, uploadId, 1);
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('spike 3: path-style URLs on S3_PUBLIC_ENDPOINT', () => {
  it('signs for the public host, path-style, and the host is bound into the signature', async (ctx) => {
    s3.skipIfUnavailable(ctx);
    const { key, uploadId } = await startUpload();
    const url = new URL(await partUrl(key, uploadId, 1));
    const publicUrl = new URL(s3.config.publicEndpoint);
    expect(url.host).toBe(publicUrl.host);
    expect(url.pathname).toBe(`/${s3.config.buckets.uploads}/${key}`);

    const swapped = new URL(url);
    swapped.hostname = url.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
    const wrongHost = await fetch(swapped, { method: 'PUT', body: Buffer.alloc(N, 5) });
    expect([wrongHost.status, await s3Code(wrongHost)]).toEqual([403, 'SignatureDoesNotMatch']);

    const ok = await fetch(url, { method: 'PUT', body: Buffer.alloc(N, 5) });
    expect(ok.status).toBe(200);
  });
});
