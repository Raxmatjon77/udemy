import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { BucketRole, ObjectInfo, ObjectStorage } from '@udemy/storage';

export interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly contentDisposition: string | undefined;
}

interface Ref {
  bucket: BucketRole;
  key: string;
}

interface Write {
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
}

/**
 * In-memory stand-in for the ObjectStorage calls the pipeline makes, so the ffmpeg-based tests
 * check real encoder output without MinIO. (The integration specs use the real MinIO.)
 */
export class FakeStorage {
  readonly objects = new Map<string, StoredObject>();

  static id({ bucket, key }: Ref): string {
    return `${bucket}:${key}`;
  }

  asObjectStorage(): ObjectStorage {
    return this as unknown as ObjectStorage;
  }

  put(ref: Ref, body: Buffer, write?: Partial<Write>): void {
    this.objects.set(FakeStorage.id(ref), {
      body,
      contentType: write?.contentType,
      cacheControl: write?.cacheControl,
      contentDisposition: write?.contentDisposition,
    });
  }

  get(ref: Ref): StoredObject | undefined {
    return this.objects.get(FakeStorage.id(ref));
  }

  keys(bucket: BucketRole): string[] {
    return [...this.objects.keys()]
      .filter((id) => id.startsWith(`${bucket}:`))
      .map((id) => id.slice(bucket.length + 1))
      .sort();
  }

  private info(ref: Ref, object: StoredObject): ObjectInfo {
    return {
      key: ref.key,
      size: object.body.length,
      etag: undefined,
      contentType: object.contentType,
      contentDisposition: object.contentDisposition,
      cacheControl: object.cacheControl,
      lastModified: undefined,
    };
  }

  async headObject(ref: Ref): Promise<ObjectInfo | null> {
    const object = this.get(ref);
    return object === undefined ? null : this.info(ref, object);
  }

  async getObjectStream(ref: Ref): Promise<{ body: Readable; info: ObjectInfo }> {
    const object = this.get(ref);
    if (object === undefined) throw new Error(`NoSuchKey ${ref.key}`);
    return { body: Readable.from([object.body]), info: this.info(ref, object) };
  }

  async getObjectRange(ref: Ref & { start: number; end: number }): Promise<Buffer> {
    const object = this.get(ref);
    if (object === undefined) throw new Error(`NoSuchKey ${ref.key}`);
    return object.body.subarray(ref.start, ref.end);
  }

  async putFile(ref: Ref & Write & { filePath: string }): Promise<{ etag: undefined }> {
    this.put(ref, await readFile(ref.filePath), ref);
    return { etag: undefined };
  }

  async copyObject(input: { from: Ref; to: Ref; write?: Write }): Promise<{ etag: undefined }> {
    const object = this.get(input.from);
    if (object === undefined) throw new Error(`NoSuchKey ${input.from.key}`);
    this.put(input.to, object.body, input.write ?? object);
    return { etag: undefined };
  }

  async deleteObject(ref: Ref): Promise<void> {
    this.objects.delete(FakeStorage.id(ref));
  }

  async deletePrefix(input: { bucket: BucketRole; prefix: string }): Promise<number> {
    let deleted = 0;
    for (const key of this.keys(input.bucket)) {
      if (key.startsWith(input.prefix)) {
        this.objects.delete(FakeStorage.id({ bucket: input.bucket, key }));
        deleted += 1;
      }
    }
    return deleted;
  }
}
