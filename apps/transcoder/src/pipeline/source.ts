import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ObjectStorage } from '@udemy/storage';
import { TranscodeFailure } from './failure';

/** Free space the work dir needs, as a multiple of the source size (design §5). */
export const FREE_SPACE_FACTOR = 3;

/** Creates `{root}/{assetId}-a{leaseNo}-XXXXXX` (0700). */
export async function createWorkDir(
  root: string,
  assetId: string,
  leaseNo: number,
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, `${assetId}-a${leaseNo}-`));
}

export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 2 });
}

export async function ensureFreeSpace(dir: string, bytesNeeded: number): Promise<void> {
  const stats = await statfs(dir);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (available < bytesNeeded) {
    throw new TranscodeFailure(
      'INTERNAL',
      `not enough scratch space in ${dir}: ${available} bytes free, ${bytesNeeded} needed`,
    );
  }
}

export interface SourceObject {
  readonly key: string;
  readonly size: number;
}

/**
 * HEADs the quarantined source and checks its size against the declared size (CompleteUpload made
 * them equal, so a difference means tampering) and the purpose limit.
 */
export async function headSource(
  storage: ObjectStorage,
  key: string,
  limits: { declaredBytes: number; maxBytes: number },
): Promise<SourceObject> {
  const info = await storage.headObject({ bucket: 'uploads', key });
  if (info === null) {
    throw new TranscodeFailure('INTERNAL', 'source object is missing', true);
  }
  if (info.size !== limits.declaredBytes) {
    throw new TranscodeFailure(
      'INVALID_MEDIA',
      `source is ${info.size} bytes, declared ${limits.declaredBytes}`,
    );
  }
  if (info.size > limits.maxBytes || info.size <= 0) {
    throw new TranscodeFailure(
      'INVALID_MEDIA',
      `source size ${info.size} outside 1..${limits.maxBytes}`,
    );
  }
  return { key, size: info.size };
}

class ByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new TranscodeFailure('INVALID_MEDIA', `source grew beyond ${this.limit} bytes`));
      return;
    }
    callback(null, chunk);
  }
}

/** Streams the source to `destPath` (created exclusively, 0600), enforcing the size. */
export async function downloadSource(
  storage: ObjectStorage,
  source: SourceObject,
  destPath: string,
  signal: AbortSignal,
): Promise<void> {
  const { body } = await storage.getObjectStream({ bucket: 'uploads', key: source.key });
  const limiter = new ByteLimit(source.size);
  try {
    await pipeline(body, limiter, createWriteStream(destPath, { flags: 'wx', mode: 0o600 }), {
      signal,
    });
  } catch (error) {
    body.destroy();
    if (signal.aborted) throw signal.reason;
    throw error;
  }
  if (limiter.bytes !== source.size) {
    throw new TranscodeFailure(
      'INTERNAL',
      `download truncated: ${limiter.bytes}/${source.size} bytes`,
    );
  }
}

/** Reads up to `bytes` from the start of a local file. */
export async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
