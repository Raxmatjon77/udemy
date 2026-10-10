import { Injectable } from '@nestjs/common';
import {
  MEDIA_ASSET_STATUSES,
  MEDIA_FAILURE_CODES,
  MEDIA_PURPOSES,
  type MediaAssetStatus,
  type MediaFailureCode,
  type MediaPurpose,
} from '@udemy/contracts';
import { type DB, type Executor, lockOwnerMediaUsage, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { OwnerUsage } from '../domain/upload-quota';
import {
  type AssetKeyset,
  type MediaAssetRecord,
  MediaAssetRepository,
  type NewUploadingAsset,
  type RenditionRecord,
} from '../application/ports/media-asset.repository';
import { mapMediaConstraints } from './media-constraint-errors';

/** Narrows a CHECK-constrained text column to its contract union (a mismatch is a bug: 500). */
export function narrow<T extends string>(values: readonly T[], value: string, column: string): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${column} value "${value}"`);
}

export function toPurpose(value: string): MediaPurpose {
  return narrow(MEDIA_PURPOSES, value, 'media.assets.purpose');
}

export function toStatus(value: string): MediaAssetStatus {
  return narrow(MEDIA_ASSET_STATUSES, value, 'media.assets.status');
}

function toFailureCode(value: string | null): MediaFailureCode | null {
  return value === null ? null : narrow(MEDIA_FAILURE_CODES, value, 'media.assets.failure_code');
}

const RENDITION_KINDS = ['HLS_VARIANT', 'IMAGE', 'SPRITE'] as const;

/** `media.assets` (+ job progress and rendition names) with Kysely. Writes map constraints (§9). */
@Injectable()
export class KyselyMediaAssetRepository extends MediaAssetRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findById(id: string, ex: Executor = this.db): Promise<MediaAssetRecord | null> {
    const row = await this.select(ex).where('a.id', '=', id).executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async findByIds(ids: readonly string[], ex: Executor = this.db): Promise<MediaAssetRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await this.select(ex).where('a.id', 'in', unique).execute();
    return rows.map(toRecord);
  }

  async findLiveOwnerId(id: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('media.assets')
      .select('ownerId')
      .where('id', '=', id)
      .where('purgedAt', 'is', null)
      .executeTakeFirst();
    return row?.ownerId ?? null;
  }

  async listPage(query: {
    ownerId: string | null;
    after: AssetKeyset | null;
    limit: number;
  }): Promise<MediaAssetRecord[]> {
    let builder = this.select(this.db);
    if (query.ownerId !== null) builder = builder.where('a.ownerId', '=', query.ownerId);
    const after = query.after;
    if (after !== null) {
      builder = builder.where(
        sql<boolean>`(a.created_at, a.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await builder
      .orderBy('a.createdAt', 'desc')
      .orderBy('a.id', 'desc')
      .limit(query.limit)
      .execute();
    return rows.map(toRecord);
  }

  async findRenditions(assetId: string, ex: Executor = this.db): Promise<RenditionRecord[]> {
    const rows = await ex
      .selectFrom('media.assetRenditions')
      .select(['name', 'kind', 'width', 'height', 'bandwidthBps', 'codecs', 'objectKey'])
      .where('assetId', '=', assetId)
      .orderBy('name')
      .execute();
    return rows.map((row) => ({
      ...row,
      kind: narrow(RENDITION_KINDS, row.kind, 'media.asset_renditions.kind'),
    }));
  }

  lockOwnerUsage(trx: Transaction<DB>, ownerId: string): Promise<OwnerUsage> {
    return lockOwnerMediaUsage(trx, ownerId);
  }

  async insertUploading(trx: Transaction<DB>, asset: NewUploadingAsset): Promise<void> {
    await mapMediaConstraints(() =>
      trx
        .insertInto('media.assets')
        .values({
          id: asset.id,
          ownerId: asset.ownerId,
          purpose: asset.purpose,
          originalFilename: asset.originalFilename,
          declaredContentType: asset.declaredContentType,
          declaredSizeBytes: String(asset.declaredSizeBytes),
          partSizeBytes: asset.partSizeBytes,
          partCount: asset.partCount,
          sourceKey: asset.sourceKey,
          s3UploadId: asset.s3UploadId,
        })
        .execute(),
    );
  }

  async markUploaded(trx: Transaction<DB>, id: string): Promise<Date | null> {
    const row = await mapMediaConstraints(() =>
      trx
        .updateTable('media.assets')
        .set({ status: 'UPLOADED', s3UploadId: null, uploadedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .where('status', '=', 'UPLOADING')
        .returning('uploadedAt')
        .executeTakeFirst(),
    );
    return row?.uploadedAt ?? null;
  }

  async markUploadFailed(
    trx: Transaction<DB>,
    id: string,
    failureCode: MediaFailureCode,
  ): Promise<Date | null> {
    const row = await mapMediaConstraints(() =>
      trx
        .updateTable('media.assets')
        .set({ status: 'FAILED', s3UploadId: null, failureCode, failedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .where('status', '=', 'UPLOADING')
        .returning('failedAt')
        .executeTakeFirst(),
    );
    return row?.failedAt ?? null;
  }

  async markAborted(trx: Transaction<DB>, id: string): Promise<string | null> {
    // PG 18 `RETURNING old.*`: the upload id the UPDATE just cleared, in one statement.
    const { rows } = await mapMediaConstraints(() =>
      sql<{ s3UploadId: string | null }>`
        UPDATE media.assets SET status = 'ABORTED', s3_upload_id = NULL
         WHERE id = ${id} AND status = 'UPLOADING'
        RETURNING old.s3_upload_id AS s3_upload_id
      `.execute(trx),
    );
    return rows[0]?.s3UploadId ?? null;
  }

  private select(ex: Executor) {
    return ex
      .selectFrom('media.assets as a')
      .leftJoin('media.transcodeJobs as j', 'j.assetId', 'a.id')
      .select([
        'a.id',
        'a.ownerId',
        'a.purpose',
        'a.status',
        'a.originalFilename',
        'a.declaredContentType',
        'a.declaredSizeBytes',
        'a.partSizeBytes',
        'a.partCount',
        'a.sourceKey',
        'a.s3UploadId',
        'a.outputPrefix',
        'a.durationMs',
        'a.width',
        'a.height',
        'a.failureCode',
        'a.purgedAt',
        'a.createdAt',
        'j.progressPct',
      ])
      .select([
        sql<string>`to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'createdAtText',
        ),
        sql<
          string[]
        >`coalesce((SELECT array_agg(r.name ORDER BY r.name) FROM media.asset_renditions r WHERE r.asset_id = a.id), '{}')`.as(
          'renditions',
        ),
      ]);
  }
}

interface AssetRow {
  id: string;
  ownerId: string;
  purpose: string;
  status: string;
  originalFilename: string;
  declaredContentType: string;
  declaredSizeBytes: string;
  partSizeBytes: number;
  partCount: number;
  sourceKey: string;
  s3UploadId: string | null;
  outputPrefix: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  failureCode: string | null;
  purgedAt: Date | null;
  createdAt: Date;
  progressPct: number | null;
  createdAtText: string;
  renditions: string[];
}

function toRecord(row: AssetRow): MediaAssetRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    purpose: toPurpose(row.purpose),
    status: toStatus(row.status),
    originalFilename: row.originalFilename,
    declaredContentType: row.declaredContentType,
    // ≤ 5 TiB by CHECK, so a JS number is exact.
    declaredSizeBytes: Number(row.declaredSizeBytes),
    partSizeBytes: row.partSizeBytes,
    partCount: row.partCount,
    sourceKey: row.sourceKey,
    s3UploadId: row.s3UploadId,
    outputPrefix: row.outputPrefix,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    failureCode: toFailureCode(row.failureCode),
    purged: row.purgedAt !== null,
    createdAt: row.createdAt,
    createdAtText: row.createdAtText,
    progressPct: row.progressPct,
    renditions: row.renditions,
  };
}
