import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import {
  abortStaleUploads,
  findLiveUploadIds,
  markSourcesDeleted,
  purgeUnusedAssets,
} from './cleanup';
import { lockOwnerMediaUsage, MEDIA_QUOTA_LOCK_CLASS } from './quota';
import { lockAssets, releaseConsumerUsages } from './usages';

describe('media cleanup SQL', () => {
  it('A returns the pre-update UploadId through RETURNING old.', async () => {
    const s = scriptedDb([{ rows: [{ id: 'a', source_key: 'k', s3_upload_id: 'u' }] }]);
    expect(await abortStaleUploads(s.db, { ttlHours: 24, batchSize: 100 })).toEqual([
      { id: 'a', sourceKey: 'k', s3UploadId: 'u' },
    ]);
    expect(s.statements[0]).toContain('old.s3_upload_id');
    expect(s.statements[0]).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('C re-checks on the locked row and skips assets with active jobs', async () => {
    const s = scriptedDb();
    await purgeUnusedAssets(s.db, { neverUsedGraceHours: 24, releasedGraceDays: 7, batchSize: 50 });
    const q = s.statements[0]!;
    expect(q).toContain('FOR UPDATE OF a SKIP LOCKED');
    expect(q).toContain("j.status IN ('QUEUED','RUNNING')");
    expect(q).toMatch(
      /WHERE a\.id = doomed\.id AND a\.purged_at IS NULL AND a\.unused_since IS NOT NULL/,
    );
  });

  it('short-circuits empty id lists and validates batch sizes', async () => {
    const s = scriptedDb();
    expect(await findLiveUploadIds(s.db, [])).toEqual(new Set());
    expect(await markSourcesDeleted(s.db, [])).toBe(0);
    await expect(
      purgeUnusedAssets(s.db, { neverUsedGraceHours: 24, releasedGraceDays: 7, batchSize: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(abortStaleUploads(s.db, { ttlHours: 0, batchSize: 10 })).rejects.toThrow(
      RangeError,
    );
    expect(s.statements).toEqual([]);
  });
});

describe('quota and usage locking need a transaction', () => {
  it('rejects a bare Kysely instance', async () => {
    const s = scriptedDb();
    await expect(lockOwnerMediaUsage(s.db, 'o')).rejects.toThrow(/inside a transaction/);
    await expect(lockAssets(s.db, ['a'])).rejects.toThrow(/inside a transaction/);
    await expect(
      releaseConsumerUsages(s.db, { consumerType: 'catalog.lecture', consumerId: 'c' }),
    ).rejects.toThrow(/inside a transaction/);
  });

  it('takes the two-int advisory lock before reading usage', async () => {
    const s = scriptedDb([{ rows: [] }, { rows: [{ used_bytes: '42', uploading: 2 }] }]);
    const usage = await s.db.transaction().execute((trx) => lockOwnerMediaUsage(trx, 'o'));
    expect(usage).toEqual({ usedBytes: '42', uploading: 2 });
    expect(s.statements[1]).toContain('pg_advisory_xact_lock');
    expect(s.parameters[1]).toEqual([MEDIA_QUOTA_LOCK_CLASS, 'o']);
  });

  it('locks assets deduplicated, ascending, FOR NO KEY UPDATE', async () => {
    const s = scriptedDb();
    await s.db.transaction().execute((trx) => lockAssets(trx, ['b', 'a', 'b']));
    expect(s.statements[1]).toContain('ORDER BY id FOR NO KEY UPDATE');
    expect(s.parameters[1]).toEqual([['b', 'a']]);
  });
});
