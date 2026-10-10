import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import {
  completeTranscodeJob,
  enqueueTranscodeJob,
  failTranscodeJob,
  heartbeatTranscodeJob,
  leaseTranscodeJob,
  reapExpiredTranscodeLeases,
  releaseTranscodeJob,
  TranscodeLeaseLostError,
  transcodeOutputPrefix,
} from './transcoder';

const A = '01a124b9-0000-7000-8000-000000000001';
const fence = { assetId: A, workerId: 'w1', leaseNo: 3 };
const one = { numAffectedRows: 1n };
const none = { numAffectedRows: 0n };

describe('leaseTranscodeJob', () => {
  it('returns null and commits when nothing is due', async () => {
    const s = scriptedDb([{ rows: [] }]);
    expect(await leaseTranscodeJob(s.db, { workerId: 'w1', leaseMs: 60_000 })).toBeNull();
    expect(s.statements[0]).toBe('BEGIN');
    expect(s.statements[1]).toContain('FOR UPDATE SKIP LOCKED');
    expect(s.statements.at(-1)).toBe('COMMIT');
    expect(s.parameters[1]).toEqual(['w1', 60_000]);
  });

  it('cancels the job when the asset is gone/purged (L2b) and opens no attempt', async () => {
    const job = { asset_id: A, attempts: 1, max_attempts: 3, lease_count: 2 };
    const s = scriptedDb([{ rows: [job] }, { rows: [] }, one]);
    expect(await leaseTranscodeJob(s.db, { workerId: 'w1', leaseMs: 60_000 })).toEqual({
      kind: 'cancelled',
      assetId: A,
      leaseNo: 2,
    });
    expect(s.statements[3]).toContain("SET status = 'CANCELLED'");
    expect(s.statements.join('\n')).not.toContain('transcode_attempts');
  });

  it('leases: asset PROCESSING + attempt row numbered by lease_count', async () => {
    const job = { asset_id: A, attempts: 1, max_attempts: 3, lease_count: 2 };
    const asset = {
      owner_id: 'o',
      purpose: 'LECTURE_VIDEO',
      source_key: 'k',
      declared_size_bytes: '10',
      declared_content_type: 'video/mp4',
    };
    const s = scriptedDb([{ rows: [job] }, { rows: [asset] }, one]);
    expect(await leaseTranscodeJob(s.db, { workerId: 'w1', leaseMs: 60_000 })).toEqual({
      kind: 'leased',
      assetId: A,
      leaseNo: 2,
      attempts: 1,
      maxAttempts: 3,
      asset: {
        ownerId: 'o',
        purpose: 'LECTURE_VIDEO',
        sourceKey: 'k',
        declaredSizeBytes: '10',
        declaredContentType: 'video/mp4',
      },
    });
    expect(s.statements[3]).toContain('INSERT INTO media.transcode_attempts');
    expect(s.parameters[3]).toEqual([A, 2, 'w1']);
  });

  it('validates its arguments before touching the database', async () => {
    const s = scriptedDb();
    await expect(leaseTranscodeJob(s.db, { workerId: '', leaseMs: 60_000 })).rejects.toThrow(
      RangeError,
    );
    await expect(leaseTranscodeJob(s.db, { workerId: 'w', leaseMs: 10 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      heartbeatTranscodeJob(s.db, { ...fence, leaseMs: 60_000, progressPct: 101 }),
    ).rejects.toThrow(RangeError);
    await expect(
      failTranscodeJob(s.db, { ...fence, code: 'NOPE' as never, retryable: true }),
    ).rejects.toThrow(RangeError);
    expect(s.statements).toEqual([]);
  });
});

describe('fenced writes', () => {
  it('heartbeat returns null when the fence does not match', async () => {
    const s = scriptedDb([{ rows: [] }]);
    expect(await heartbeatTranscodeJob(s.db, { ...fence, leaseMs: 60_000 })).toBeNull();
    expect(s.statements[0]).toContain('lease_owner = $');
    expect(s.statements[0]).toContain('lease_count = $');
  });

  it('complete rolls back with TranscodeLeaseLostError when the job update matches 0 rows', async () => {
    const s = scriptedDb([none]);
    const err = await completeTranscodeJob(s.db, {
      ...fence,
      durationMs: 1,
      width: 1,
      height: 1,
      detectedFormat: null,
      renditions: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscodeLeaseLostError);
    expect(err).toMatchObject({ step: 'complete:job', leaseNo: 3 });
    expect(s.statements.at(-1)).toBe('ROLLBACK');
  });

  it('complete writes the a{leaseNo} output prefix', async () => {
    const asset = {
      id: A,
      owner_id: 'o',
      purpose: 'LECTURE_VIDEO',
      output_prefix: transcodeOutputPrefix(A, 3),
      duration_ms: 1,
      width: 1,
      height: 1,
      ready_at: new Date(),
    };
    const s = scriptedDb([one, { rows: [asset] }, one]);
    await completeTranscodeJob(s.db, {
      ...fence,
      durationMs: 1,
      width: 1,
      height: 1,
      detectedFormat: null,
      renditions: [],
    });
    expect(s.parameters[2]).toContain(`assets/${A}/a3/`);
    expect(s.statements.at(-1)).toBe('COMMIT');
  });

  it('a retryable failure with no attempts left takes the terminal path', async () => {
    const s = scriptedDb([
      { rows: [] },
      { rows: [{ attempts: 3 }] },
      { rows: [{ owner_id: 'o', purpose: 'p', source_key: 'k' }] },
      one,
    ]);
    expect(
      await failTranscodeJob(s.db, {
        ...fence,
        code: 'TIMEOUT',
        retryable: true,
        detail: 'x'.repeat(5000),
      }),
    ).toEqual({
      outcome: 'FAILED',
      attempts: 3,
      asset: { ownerId: 'o', purpose: 'p', sourceKey: 'k' },
    });
    expect(s.statements[1]).toContain('attempts < max_attempts');
    expect(s.statements[2]).toContain("SET status = 'FAILED'");
    expect(
      (s.parameters[4] as unknown[]).find((p) => typeof p === 'string' && p.length === 2000),
    ).toBeDefined();
  });

  it('release returns false when the lease is already lost', async () => {
    const s = scriptedDb([none]);
    expect(await releaseTranscodeJob(s.db, fence)).toBe(false);
  });

  it('enqueue reports whether a job was created', async () => {
    expect(await enqueueTranscodeJob(scriptedDb([one]).db, A)).toBe(true);
    expect(await enqueueTranscodeJob(scriptedDb([none]).db, A)).toBe(false);
  });

  it('the reaper requeues while attempts remain and fails terminally otherwise', async () => {
    const s = scriptedDb([
      {
        rows: [
          { asset_id: 'a1', attempts: 1, max_attempts: 3, lease_count: 1 },
          { asset_id: 'a2', attempts: 3, max_attempts: 3, lease_count: 5 },
        ],
      },
      one,
      one, // a1: close attempt, requeue
      one,
      one,
      { rows: [] }, // a2: close attempt, job FAILED, asset no longer PROCESSING
    ]);
    expect(await reapExpiredTranscodeLeases(s.db, { batchSize: 20 })).toEqual([
      { assetId: 'a1', leaseNo: 1, outcome: 'REQUEUED' },
      { assetId: 'a2', leaseNo: 5, outcome: 'FAILED', attempts: 3, asset: null },
    ]);
  });
});
