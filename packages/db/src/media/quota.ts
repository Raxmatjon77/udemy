/**
 * Upload quota check (docs/phase-2-schema-design.md §8.4), for InitiateUpload (api, T8).
 * Run it in the transaction that inserts the asset: the advisory lock serialises concurrent
 * InitiateUploads of one owner until COMMIT.
 */
import { sql } from 'kysely';
import { type Executor, requireTransaction } from '../transaction';

/** First key of the two-int advisory lock (0x6d717461 'mqta'); second key = hashtext(owner id). */
export const MEDIA_QUOTA_LOCK_CLASS = 1836151905;

export interface OwnerMediaUsage {
  /** Σ declared_size_bytes of non-purged UPLOADING/UPLOADED/PROCESSING/READY assets (int8 -> string). */
  usedBytes: string;
  /** Number of UPLOADING assets. */
  uploading: number;
}

/**
 * Takes the per-owner quota lock, then reads usage (index-only on assets_owner_id_quota_idx).
 * The caller decides: `usedBytes + size > MEDIA_QUOTA_BYTES_PER_OWNER` -> quota_exceeded,
 * `uploading >= MEDIA_MAX_CONCURRENT_UPLOADS` -> too_many_uploads.
 */
export async function lockOwnerMediaUsage(
  executor: Executor,
  ownerId: string,
): Promise<OwnerMediaUsage> {
  const trx = requireTransaction(executor, 'lockOwnerMediaUsage');
  await sql`SELECT pg_advisory_xact_lock(${MEDIA_QUOTA_LOCK_CLASS}::int, hashtext(${ownerId}::text))`.execute(
    trx,
  );
  const { rows } = await sql<OwnerMediaUsage>`
    SELECT coalesce(sum(declared_size_bytes), 0)::bigint      AS used_bytes,
           count(*) FILTER (WHERE status = 'UPLOADING')::int  AS uploading
      FROM media.assets
     WHERE owner_id = ${ownerId} AND purged_at IS NULL
       AND status IN ('UPLOADING','UPLOADED','PROCESSING','READY')
  `.execute(trx);
  const row = rows[0];
  return { usedBytes: row?.usedBytes ?? '0', uploading: row?.uploading ?? 0 };
}
