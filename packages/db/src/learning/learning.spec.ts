import { describe, expect, it } from 'vitest';
import { asciiLockClass } from '../internal/advisory';
import { MEDIA_QUOTA_LOCK_CLASS } from '../media/quota';
import { scriptedDb } from '../testing/scripted-db';
import { transitionCertificate, issueCertificate, certificatePdfObjectKey } from './certificates';
import { recordLectureCompletion, getCourseProgressCounts } from './completion';
import { consumptionReviewReason, type LearningConsumption } from './consumption';
import {
  countCoveredBuckets,
  coverageBucketCount,
  coverageHexLiteral,
  coverageTextToBytes,
} from './coverage';
import {
  LEARNING_COMPLETION_LOCK_CLASS,
  LEARNING_MAINTENANCE_LOCK_KEY,
  LEARNING_PROGRESS_FLUSH_LOCK_KEY,
  lockLearningCompletion,
  NOTES_CAP_LOCK_CLASS,
} from './locks';
import { upsertLectureProgress, type LectureProgressInput } from './progress';
import { NOTIFICATION_RETENTION_LOCK_KEY } from '../notifications/retention';
import { ANNOUNCEMENT_QUOTA_LOCK_CLASS, WISHLIST_CAP_LOCK_CLASS } from '../engagement/locks';

const U1 = '01900000-0000-7000-8000-0000000000a1';
const U2 = '01900000-0000-7000-8000-0000000000a2';
const L1 = '01900000-0000-7000-8000-0000000000b1';
const L2 = '01900000-0000-7000-8000-0000000000b2';
const C = '01900000-0000-7000-8000-0000000000cc';
const A = '01900000-0000-7000-8000-0000000000dd';

describe('lock constants (schema doc §10, open point 9)', () => {
  it('match the ASCII classes and the 0x75646d79_NN job keys', () => {
    expect(LEARNING_COMPLETION_LOCK_CLASS).toBe(asciiLockClass('lrnc'));
    expect(ANNOUNCEMENT_QUOTA_LOCK_CLASS).toBe(asciiLockClass('anno'));
    expect(NOTES_CAP_LOCK_CLASS).toBe(asciiLockClass('note'));
    expect(WISHLIST_CAP_LOCK_CLASS).toBe(asciiLockClass('wish'));
    expect(MEDIA_QUOTA_LOCK_CLASS).toBe(asciiLockClass('mqta'));
    expect([LEARNING_COMPLETION_LOCK_CLASS, ANNOUNCEMENT_QUOTA_LOCK_CLASS]).toEqual([
      1819438691, 1634627183,
    ]);
    expect([NOTES_CAP_LOCK_CLASS, WISHLIST_CAP_LOCK_CLASS]).toEqual([1852798053, 2003399528]);
    expect([
      LEARNING_PROGRESS_FLUSH_LOCK_KEY,
      NOTIFICATION_RETENTION_LOCK_KEY,
      LEARNING_MAINTENANCE_LOCK_KEY,
    ]).toEqual([504196069638, 504196069639, 504196069640]);
  });

  it('two-int locks need a transaction and hash the canonical uuid text', async () => {
    const s = scriptedDb();
    await expect(lockLearningCompletion(s.db, U1, C)).rejects.toThrow(/transaction/);
    await s.db.transaction().execute((trx) => lockLearningCompletion(trx, U1, C));
    expect(s.statements[1]).toBe(
      "SELECT pg_advisory_xact_lock($1::int, hashtext($2::uuid::text || ':' || $3::uuid::text))",
    );
    expect(s.parameters[1]).toEqual([1819438691, U1, C]);
  });
});

describe('coverage encoding', () => {
  it('bucket count = ceil(duration / 5) within 1..86400', () => {
    expect(coverageBucketCount(1)).toBe(1);
    expect(coverageBucketCount(5)).toBe(1);
    expect(coverageBucketCount(6)).toBe(2);
    expect(coverageBucketCount(86_400)).toBe(17_280);
    expect(() => coverageBucketCount(0)).toThrow(RangeError);
    expect(() => coverageBucketCount(86_401)).toThrow(RangeError);
    expect(() => coverageBucketCount(1.5)).toThrow(RangeError);
  });

  it('hex literal is MSB-first bytes; an empty bitmap is one zero byte', () => {
    expect(coverageHexLiteral(Uint8Array.from([0xa0, 0xff]))).toBe('xa0ff');
    expect(coverageHexLiteral(new Uint8Array())).toBe('x00');
    const sub = Uint8Array.from([0x00, 0x80, 0x01]).subarray(1, 2);
    expect(coverageHexLiteral(sub)).toBe('x80');
  });

  it('round-trips the DB text form and counts set buckets', () => {
    const bytes = coverageTextToBytes('1010000011111111101');
    expect([...bytes]).toEqual([0xa0, 0xff, 0xa0]);
    expect(countCoveredBuckets(bytes, 19)).toBe(12);
    expect(countCoveredBuckets(bytes, 3)).toBe(2);
    expect(() => coverageTextToBytes('012')).toThrow(RangeError);
  });
});

function row(over: Partial<LectureProgressInput> = {}): LectureProgressInput {
  return {
    userId: U1,
    lectureId: L1,
    courseId: C,
    mediaAssetId: A,
    durationSeconds: 61,
    positionSeconds: 30,
    coverage: Uint8Array.from([0xf0]),
    firstWatchedAt: new Date('2026-10-24T10:00:00.123Z'),
    lastWatchedAt: new Date('2026-10-24T10:01:00.456Z'),
    ...over,
  };
}

describe('upsertLectureProgress', () => {
  it('sends sorted parallel arrays, hex coverage and ISO timestamps; ORs only through fit_coverage', async () => {
    const s = scriptedDb([{ rows: [] }]);
    await upsertLectureProgress(s.db, [row({ userId: U2 }), row({ lectureId: L2 }), row()]);
    const q = s.statements[0]!;
    expect(q).toContain(
      'learning.fit_coverage(b.coverage_hex::varbit, (b.duration_seconds + 4) / 5)',
    );
    expect(q).toContain(
      'THEN p.coverage | learning.fit_coverage(EXCLUDED.coverage, length(p.coverage))',
    );
    expect(q).toContain('ON CONFLICT (user_id, lecture_id) DO UPDATE SET');
    expect(q).toContain('learning.coverage_bits(coverage) AS covered_buckets');
    const p = s.parameters[0]!;
    expect(p[0]).toEqual([U1, U1, U2]);
    expect(p[1]).toEqual([L1, L2, L1]);
    expect(p[6]).toEqual(['xf0', 'xf0', 'xf0']);
    expect(p[7]).toEqual(Array(3).fill('2026-10-24T10:00:00.123Z'));
  });

  it('rejects duplicates (ON CONFLICT cannot touch a row twice), bad durations and empty batches', async () => {
    const s = scriptedDb();
    await expect(
      upsertLectureProgress(s.db, [row(), row({ lectureId: L1.toUpperCase() })]),
    ).rejects.toThrow(/duplicate/);
    await expect(upsertLectureProgress(s.db, [row({ durationSeconds: 0 })])).rejects.toThrow(
      RangeError,
    );
    await expect(upsertLectureProgress(s.db, [])).rejects.toThrow(RangeError);
    expect(s.statements).toEqual([]);
  });
});

describe('recordLectureCompletion', () => {
  it('validates the cause against the type and the quiz attempt before any SQL', async () => {
    const s = scriptedDb();
    const base = {
      userId: U1,
      courseId: C,
      lectureId: L1,
      revisionId: A,
      liveLectureIds: [L1],
    };
    await s.db.transaction().execute(async (trx) => {
      await expect(
        recordLectureCompletion(trx, { ...base, lectureType: 'VIDEO', cause: 'MANUAL' }),
      ).rejects.toThrow(/not allowed/);
      await expect(
        recordLectureCompletion(trx, { ...base, lectureType: 'QUIZ', cause: 'QUIZ_PASSED' }),
      ).rejects.toThrow(/quizAttemptId/);
      await expect(
        recordLectureCompletion(trx, {
          ...base,
          lectureType: 'ARTICLE',
          cause: 'MANUAL',
          liveLectureIds: [],
        }),
      ).rejects.toThrow(RangeError);
    });
    expect(s.statements).toEqual(['BEGIN', 'COMMIT']);
  });

  it('locks, inserts, then counts in a new statement and inserts the course completion', async () => {
    const at = new Date();
    const s = scriptedDb([
      {},
      { rows: [{ completed_at: at }] },
      { rows: [{ done: 2 }] },
      { rows: [{ completed_at: at }] },
    ]);
    const r = await s.db.transaction().execute((trx) =>
      recordLectureCompletion(trx, {
        userId: U1,
        courseId: C,
        lectureId: L1,
        lectureType: 'ARTICLE',
        cause: 'ARTICLE_READ',
        revisionId: A,
        liveLectureIds: [L1, L2, L2],
      }),
    );
    expect(r).toEqual({
      lecture: { completedAt: at },
      course: {
        completedLectures: 2,
        totalLectures: 2,
        completion: { completedAt: at, newlyCompleted: true },
      },
    });
    expect(s.statements[1]).toContain('pg_advisory_xact_lock');
    expect(s.statements[2]).toContain('ON CONFLICT (user_id, lecture_id) DO NOTHING');
    expect(s.statements[3]).toContain('lecture_id = ANY($2::uuid[])');
    expect(s.statements[4]).toContain('INSERT INTO learning.course_completions');
    expect(s.parameters[4]).toEqual([U1, C, A, 2]);
  });

  it('getCourseProgressCounts reports empty courses as 0/0 without SQL', async () => {
    const s = scriptedDb();
    const r = await getCourseProgressCounts(s.db, U1, [{ courseId: C, lectureIds: [] }]);
    expect(r.get(C)).toEqual({ completed: 0, total: 0 });
    expect(s.statements).toEqual([]);
  });
});

describe('consumptionReviewReason (P5-D6)', () => {
  const base: LearningConsumption = {
    videoSecondsWatched: 0,
    videoSecondsTotal: 1000,
    completedLectures: 0,
    totalLectures: 10,
    courseCompletedAt: null,
    certificateStatus: null,
  };
  it('certificate first, then video, then lectures; strict > with integer math', () => {
    expect(consumptionReviewReason({ ...base, certificateStatus: 'ACTIVE' }, 30)).toBe(
      'certificate_issued',
    );
    expect(consumptionReviewReason({ ...base, videoSecondsWatched: 300 }, 30)).toBeNull();
    expect(consumptionReviewReason({ ...base, videoSecondsWatched: 301 }, 30)).toBe(
      'consumed_video_30',
    );
    expect(consumptionReviewReason({ ...base, completedLectures: 3 }, 30)).toBeNull();
    expect(consumptionReviewReason({ ...base, completedLectures: 4 }, 30)).toBe(
      'consumed_lectures_40',
    );
    expect(
      consumptionReviewReason({ ...base, certificateStatus: 'REVOKED', videoSecondsTotal: 0 }, 30),
    ).toBeNull();
  });
});

describe('certificates', () => {
  it('pdf key is the one certificates_pdf_ck accepts', () => {
    expect(certificatePdfObjectKey('01900000-0000-7000-8000-0000000000EE')).toBe(
      'certificates/01900000-0000-7000-8000-0000000000ee/v1.pdf',
    );
  });

  it('issueCertificate: CODE_TAKEN when nothing was inserted and no row matches', async () => {
    const s = scriptedDb([{ rows: [] }, { rows: [] }]);
    const r = await s.db.transaction().execute((trx) =>
      issueCertificate(trx, {
        userId: U1,
        courseId: C,
        revisionId: A,
        publicCode: '01J9ZP4X6V8Q2M3N5R7T9W0Y1A',
        recipientName: 'Ada',
        courseTitle: 'Course',
        instructorName: 'Grace',
        sourceEventId: L1,
      }),
    );
    expect(r).toEqual({ outcome: 'CODE_TAKEN' });
    expect(s.statements[1]).toContain('ON CONFLICT DO NOTHING');
  });

  it('transitionCertificate: a regrant over an admin revoke is skipped (R13); revoked_at uses now()', async () => {
    const skip = scriptedDb([
      { rows: [{ status: 'REVOKED' }] },
      { rows: [{ seq: 2, cause: 'ADMIN' }] },
    ]);
    const r = await skip.db.transaction().execute((trx) =>
      transitionCertificate(trx, {
        certificateId: L1,
        action: 'REINSTATE',
        cause: 'ENROLLMENT_REGRANTED',
        sourceEventId: L2,
      }),
    );
    expect(r).toEqual({ outcome: 'SKIPPED_ADMIN_REVOKE', status: 'REVOKED' });
    expect(skip.statements.some((q) => q.startsWith('INSERT'))).toBe(false);

    const at = new Date();
    const apply = scriptedDb([
      { rows: [{ status: 'ACTIVE' }] },
      { rows: [{ seq: 1, cause: 'COURSE_COMPLETED' }] },
      { rows: [{ seq: 2, occurred_at: at }] },
      {},
    ]);
    const a = await apply.db.transaction().execute((trx) =>
      transitionCertificate(trx, {
        certificateId: L1,
        action: 'REVOKE',
        cause: 'ENROLLMENT_REVOKED',
        sourceEventId: L2,
      }),
    );
    expect(a).toEqual({ outcome: 'APPLIED', seq: 2, status: 'REVOKED', occurredAt: at });
    expect(apply.statements[4]).toContain('revoked_at = now()');
    expect(apply.parameters[3]).toContain(2);
  });

  it('transitionCertificate validates admin reasons and cause/action pairs', async () => {
    const s = scriptedDb();
    await s.db.transaction().execute(async (trx) => {
      await expect(
        transitionCertificate(trx, {
          certificateId: L1,
          action: 'REVOKE',
          cause: 'ADMIN',
          actorId: U1,
          reason: 'short',
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        transitionCertificate(trx, {
          certificateId: L1,
          action: 'REVOKE',
          cause: 'ENROLLMENT_REGRANTED',
          sourceEventId: L2,
        } as never),
      ).rejects.toThrow(RangeError);
    });
  });
});
