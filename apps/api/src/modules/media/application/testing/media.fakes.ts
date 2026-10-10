import type { Permission } from '@udemy/contracts';
import type { AssetUsageKey, DB, Executor, Transaction } from '@udemy/db';
import type { ListedPart, PartPlan } from '@udemy/storage';
import { RateLimitedError } from '../../../../shared/errors';
import type { AuthorizationSubject } from '../../../access';
import type { MediaAssetStatus, MediaFailureCode } from '../../domain/media-asset';
import {
  MediaAssetNotFound,
  MediaAssetUnusable,
  MediaPurposeMismatch,
} from '../../domain/media.errors';
import type { OwnerUsage } from '../../domain/upload-quota';
import type { AssetConsumerType } from '../dto';
import { MediaSettings } from '../media-settings';
import { AssetUsageRepository, type LockedAssetRecord } from '../ports/asset-usage.repository';
import type { MediaEventPublisher } from '../ports/media-event.publisher';
import {
  type AssetKeyset,
  type MediaAssetRecord,
  MediaAssetRepository,
  type NewUploadingAsset,
  type RenditionRecord,
} from '../ports/media-asset.repository';
import { MediaObjectStore, type SignedObjectUrl } from '../ports/media-object.store';
import { TransactionRunner } from '../ports/transaction-runner';
import { UploadRateLimiter } from '../ports/upload-rate-limiter';

/** Stands in for a Kysely transaction; the fakes never touch it. */
export const FAKE_TRX = { isTransaction: true } as unknown as Transaction<DB>;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export function testSettings(overrides: Partial<MediaSettings['values']> = {}): MediaSettings {
  return new MediaSettings({
    partUrlTtlSeconds: 900,
    playbackUrlTtlSeconds: 3600,
    imageUrlTtlSeconds: 3600,
    downloadUrlTtlSeconds: 300,
    maxBytes: { LECTURE_VIDEO: GiB, COURSE_THUMBNAIL: 5 * MiB, LECTURE_RESOURCE: 100 * MiB },
    quota: { quotaBytes: 10 * GiB, maxConcurrentUploads: 5 },
    ...overrides,
  });
}

export function principal(userId: string, ...permissions: Permission[]): AuthorizationSubject {
  return { userId, permissions: new Set(permissions) };
}

type MutableAsset = { -readonly [K in keyof MediaAssetRecord]: MediaAssetRecord[K] };

let sequence = 0;

/** A record with sensible defaults (UPLOADING, 1 part). */
export function assetRecord(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  sequence += 1;
  const id = overrides.id ?? `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
  const ownerId = overrides.ownerId ?? '00000000-0000-7000-8000-00000000aaaa';
  const createdAt = overrides.createdAt ?? new Date(Date.UTC(2026, 9, 10, 12, 0, sequence));
  return {
    id,
    ownerId,
    purpose: 'LECTURE_VIDEO',
    status: 'UPLOADING',
    originalFilename: 'intro.mp4',
    declaredContentType: 'video/mp4',
    declaredSizeBytes: 1000,
    partSizeBytes: 8 * MiB,
    partCount: 1,
    sourceKey: `uploads/${ownerId}/${id}/source`,
    s3UploadId:
      overrides.status === undefined || overrides.status === 'UPLOADING' ? `up-${id}` : null,
    outputPrefix: null,
    durationMs: null,
    width: null,
    height: null,
    failureCode: null,
    purged: false,
    createdAt,
    createdAtText: createdAt.toISOString().replace('Z', '000Z'),
    progressPct: null,
    renditions: [],
    ...overrides,
  };
}

/** In-memory `media.assets` + renditions, enforcing the conditional status updates. */
export class FakeMediaAssetRepository extends MediaAssetRepository {
  readonly rows = new Map<string, MutableAsset>();
  readonly renditionRows = new Map<string, RenditionRecord[]>();
  readonly ownerLocks: string[] = [];
  /** Makes the next insertUploading throw this error. */
  failNextInsert: Error | undefined;
  /** Before markUploaded: simulates a concurrent writer (e.g. the janitor). */
  beforeMarkUploaded: ((id: string) => void) | undefined;

  add(record: MediaAssetRecord, renditions: RenditionRecord[] = []): MediaAssetRecord {
    this.rows.set(record.id, { ...record });
    this.renditionRows.set(record.id, renditions);
    return record;
  }

  get(id: string): MediaAssetRecord {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no asset ${id}`);
    return row;
  }

  setStatus(id: string, status: MediaAssetStatus): void {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no asset ${id}`);
    row.status = status;
    if (status !== 'UPLOADING') row.s3UploadId = null;
  }

  async findById(id: string, _ex?: Executor): Promise<MediaAssetRecord | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : this.view(row);
  }

  async findByIds(ids: readonly string[], _ex?: Executor): Promise<MediaAssetRecord[]> {
    return [...new Set(ids)].flatMap((id) => {
      const row = this.rows.get(id);
      return row === undefined ? [] : [this.view(row)];
    });
  }

  async findLiveOwnerId(id: string): Promise<string | null> {
    const row = this.rows.get(id);
    return row === undefined || row.purged ? null : row.ownerId;
  }

  async listPage(query: {
    ownerId: string | null;
    after: AssetKeyset | null;
    limit: number;
  }): Promise<MediaAssetRecord[]> {
    const after = query.after;
    return [...this.rows.values()]
      .filter((r) => query.ownerId === null || r.ownerId === query.ownerId)
      .sort((a, b) => b.createdAtText.localeCompare(a.createdAtText) || b.id.localeCompare(a.id))
      .filter(
        (r) =>
          after === null ||
          r.createdAtText < after.createdAt ||
          (r.createdAtText === after.createdAt && r.id < after.id),
      )
      .slice(0, query.limit)
      .map((r) => this.view(r));
  }

  async findRenditions(assetId: string, _ex?: Executor): Promise<RenditionRecord[]> {
    return [...(this.renditionRows.get(assetId) ?? [])];
  }

  async lockOwnerUsage(_trx: Transaction<DB>, ownerId: string): Promise<OwnerUsage> {
    this.ownerLocks.push(ownerId);
    const live = [...this.rows.values()].filter(
      (r) =>
        r.ownerId === ownerId &&
        !r.purged &&
        ['UPLOADING', 'UPLOADED', 'PROCESSING', 'READY'].includes(r.status),
    );
    return {
      usedBytes: String(live.reduce((sum, r) => sum + r.declaredSizeBytes, 0)),
      uploading: live.filter((r) => r.status === 'UPLOADING').length,
    };
  }

  async insertUploading(_trx: Transaction<DB>, asset: NewUploadingAsset): Promise<void> {
    if (this.failNextInsert !== undefined) {
      const error = this.failNextInsert;
      this.failNextInsert = undefined;
      throw error;
    }
    this.add(
      assetRecord({
        ...asset,
        status: 'UPLOADING',
        s3UploadId: asset.s3UploadId,
      }),
    );
  }

  async markUploaded(_trx: Transaction<DB>, id: string): Promise<Date | null> {
    this.beforeMarkUploaded?.(id);
    const row = this.rows.get(id);
    if (row?.status !== 'UPLOADING') return null;
    row.status = 'UPLOADED';
    row.s3UploadId = null;
    return new Date('2026-10-10T12:30:00.000Z');
  }

  async markUploadFailed(
    _trx: Transaction<DB>,
    id: string,
    failureCode: MediaFailureCode,
  ): Promise<Date | null> {
    const row = this.rows.get(id);
    if (row?.status !== 'UPLOADING') return null;
    row.status = 'FAILED';
    row.failureCode = failureCode;
    row.s3UploadId = null;
    return new Date('2026-10-10T12:31:00.000Z');
  }

  async markAborted(_trx: Transaction<DB>, id: string): Promise<string | null> {
    const row = this.rows.get(id);
    if (row?.status !== 'UPLOADING') return null;
    const uploadId = row.s3UploadId;
    row.status = 'ABORTED';
    row.s3UploadId = null;
    return uploadId;
  }

  private view(row: MutableAsset): MediaAssetRecord {
    const renditions = (this.renditionRows.get(row.id) ?? []).map((r) => r.name).sort();
    return { ...row, renditions: renditions.length > 0 ? renditions : row.renditions };
  }
}

/** In-memory `media.asset_usages`, with the trigger and unique-index rules of §9. */
export class FakeAssetUsageRepository extends AssetUsageRepository {
  readonly usages: AssetUsageKey[] = [];
  readonly lockCalls: string[][] = [];

  constructor(private readonly assets: FakeMediaAssetRepository) {
    super();
  }

  async lockAssets(_trx: Transaction<DB>, ids: readonly string[]): Promise<LockedAssetRecord[]> {
    const sorted = [...new Set(ids)].sort();
    this.lockCalls.push(sorted);
    return sorted.flatMap((id) => {
      const row = this.assets.rows.get(id);
      return row === undefined
        ? []
        : [
            {
              id: row.id,
              ownerId: row.ownerId,
              purpose: row.purpose,
              status: row.status,
              purged: row.purged,
            },
          ];
    });
  }

  async insert(_trx: Transaction<DB>, usage: AssetUsageKey): Promise<boolean> {
    const asset = this.assets.rows.get(usage.assetId);
    if (asset === undefined) throw new MediaAssetNotFound();
    if (
      asset.purged ||
      asset.status === 'FAILED' ||
      asset.status === 'ABORTED' ||
      (usage.consumerType === 'catalog.course_revision' && asset.status !== 'READY')
    ) {
      throw new MediaAssetUnusable();
    }
    if (
      (usage.consumerType === 'catalog.course_thumbnail' && asset.purpose !== 'COURSE_THUMBNAIL') ||
      (usage.consumerType === 'catalog.lecture' && asset.purpose === 'COURSE_THUMBNAIL')
    ) {
      throw new MediaPurposeMismatch();
    }
    if (this.usages.some((u) => sameUsage(u, usage))) return false;
    if (
      usage.consumerType !== 'catalog.course_revision' &&
      this.usages.some(
        (u) => u.assetId === usage.assetId && u.consumerType !== 'catalog.course_revision',
      )
    ) {
      throw new MediaAssetUnusable();
    }
    this.usages.push({ ...usage });
    return true;
  }

  async delete(_trx: Transaction<DB>, usage: AssetUsageKey): Promise<boolean> {
    const index = this.usages.findIndex((u) => sameUsage(u, usage));
    if (index < 0) return false;
    this.usages.splice(index, 1);
    return true;
  }

  async releaseConsumer(
    trx: Transaction<DB>,
    consumer: { consumerType: AssetConsumerType; consumerId: string },
  ): Promise<string[]> {
    const held = this.usages.filter(
      (u) => u.consumerType === consumer.consumerType && u.consumerId === consumer.consumerId,
    );
    await this.lockAssets(
      trx,
      held.map((u) => u.assetId),
    );
    for (const u of held) await this.delete(trx, u);
    return held.map((u) => u.assetId).sort();
  }
}

function sameUsage(a: AssetUsageKey, b: AssetUsageKey): boolean {
  return (
    a.assetId === b.assetId && a.consumerType === b.consumerType && a.consumerId === b.consumerId
  );
}

interface FakeUpload {
  readonly key: string;
  readonly contentType: string;
  readonly parts: Map<number, number>;
  state: 'open' | 'completed' | 'aborted';
}

/** In-memory S3 for media: multipart uploads, source objects, media text objects. */
export class FakeMediaObjectStore extends MediaObjectStore {
  readonly uploads = new Map<string, FakeUpload>();
  /** Source key -> size of the completed object. */
  readonly sources = new Map<string, number>();
  /** Media key -> text. */
  readonly mediaTexts = new Map<string, string>();
  readonly calls: string[] = [];
  readonly presignedParts: { partNumber: number; contentLength: number; ttlSeconds: number }[] = [];
  readonly presignedGets: {
    key: string;
    ttlSeconds: number;
    responseContentType?: string;
    responseContentDisposition?: string;
  }[] = [];
  readonly reads: string[] = [];
  private counter = 0;
  /** Throws from abortSourceUpload when set. */
  abortError: Error | undefined;

  async createSourceUpload(sourceKey: string, contentType: string): Promise<string> {
    this.calls.push(`create:${sourceKey}`);
    this.counter += 1;
    const uploadId = `upload-${this.counter}`;
    this.uploads.set(uploadId, { key: sourceKey, contentType, parts: new Map(), state: 'open' });
    return uploadId;
  }

  /** Lets a test (or "the browser") store a part directly. */
  putPart(uploadId: string, partNumber: number, size: number): void {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw new Error(`no upload ${uploadId}`);
    upload.parts.set(partNumber, size);
  }

  async presignSourcePart(input: {
    sourceKey: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    ttlSeconds: number;
  }): Promise<SignedObjectUrl> {
    this.presignedParts.push({
      partNumber: input.partNumber,
      contentLength: input.contentLength,
      ttlSeconds: input.ttlSeconds,
    });
    return {
      url: `https://s3.test/${input.sourceKey}?uploadId=${input.uploadId}&partNumber=${input.partNumber}&len=${input.contentLength}`,
      expiresAt: new Date(Date.UTC(2026, 9, 10, 13, 0, 0) + input.ttlSeconds * 1000),
    };
  }

  async listSourceParts(_sourceKey: string, uploadId: string): Promise<ListedPart[] | null> {
    this.calls.push(`list:${uploadId}`);
    const upload = this.uploads.get(uploadId);
    if (upload === undefined || upload.state !== 'open') return null;
    return [...upload.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(
        ([partNumber, size]) =>
          ({
            partNumber,
            size,
            etag: `"etag-${partNumber}"`,
            lastModified: undefined,
          }) as unknown as ListedPart,
      );
  }

  async completeSourceUpload(input: {
    sourceKey: string;
    uploadId: string;
    parts: readonly ListedPart[];
    plan: PartPlan;
  }): Promise<boolean> {
    this.calls.push(`complete:${input.uploadId}`);
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined || upload.state !== 'open') return false;
    upload.state = 'completed';
    this.sources.set(
      input.sourceKey,
      input.parts.reduce((sum, p) => sum + p.size, 0),
    );
    return true;
  }

  async abortSourceUpload(_sourceKey: string, uploadId: string): Promise<void> {
    this.calls.push(`abort:${uploadId}`);
    if (this.abortError !== undefined) throw this.abortError;
    const upload = this.uploads.get(uploadId);
    if (upload !== undefined && upload.state === 'open') upload.state = 'aborted';
  }

  async sourceSize(sourceKey: string): Promise<number | null> {
    return this.sources.get(sourceKey) ?? null;
  }

  async deleteSource(sourceKey: string): Promise<void> {
    this.calls.push(`delete:${sourceKey}`);
    this.sources.delete(sourceKey);
  }

  async readMediaText(key: string): Promise<string> {
    this.reads.push(key);
    const text = this.mediaTexts.get(key);
    if (text === undefined) throw new Error(`no media object ${key}`);
    return text;
  }

  async presignMediaGet(
    key: string,
    options: {
      ttlSeconds: number;
      responseContentType?: string;
      responseContentDisposition?: string;
    },
  ): Promise<SignedObjectUrl> {
    this.presignedGets.push({ key, ...options });
    return {
      url: `https://media.test/${key}?X-Amz-Expires=${options.ttlSeconds}`,
      expiresAt: new Date(Date.UTC(2026, 9, 10, 13, 0, 0) + options.ttlSeconds * 1000),
    };
  }
}

export class FakeEventPublisher implements MediaEventPublisher {
  readonly events: { type: 'MediaUploaded' | 'MediaFailed'; payload: Record<string, unknown> }[] =
    [];

  async uploaded(
    _trx: Transaction<DB>,
    payload: Parameters<MediaEventPublisher['uploaded']>[1],
  ): Promise<void> {
    this.events.push({ type: 'MediaUploaded', payload: { ...payload } });
  }

  async failed(
    _trx: Transaction<DB>,
    payload: Parameters<MediaEventPublisher['failed']>[1],
  ): Promise<void> {
    this.events.push({ type: 'MediaFailed', payload: { ...payload } });
  }
}

export class FakeTransactionRunner extends TransactionRunner {
  runs = 0;

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    this.runs += 1;
    return work(FAKE_TRX);
  }
}

export class FakeUploadRateLimiter extends UploadRateLimiter {
  readonly hits: string[] = [];
  /** Hits allowed per key before RateLimitedError. */
  limit = Number.POSITIVE_INFINITY;

  async hitInitiate(userId: string): Promise<void> {
    this.count(`initiate:${userId}`);
  }

  async hitPresignParts(userId: string): Promise<void> {
    this.count(`parts:${userId}`);
  }

  private count(key: string): void {
    this.hits.push(key);
    if (this.hits.filter((k) => k === key).length > this.limit) {
      throw new RateLimitedError('Too many requests.', { retryAfterMs: 1000 });
    }
  }
}
