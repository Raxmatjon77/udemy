import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import {
  advanceFanoutJob,
  enqueueAnnouncementFanout,
  failFanoutAttempt,
  insertAnnouncementNotifications,
  leaseFanoutJob,
  lockFanoutBatch,
} from './fanout';
import { deleteExpiredNotifications } from './retention';

const J = '01900000-0000-7000-8000-0000000000f1';
const C = '01900000-0000-7000-8000-0000000000cc';
const E = '01900000-0000-7000-8000-0000000000ee';
const fence = { jobId: J, workerId: 'worker-1', attempt: 2 };

describe('fan-out lease', () => {
  it('enqueue is idempotent on the source event and uses the column default for max_attempts', async () => {
    const s = scriptedDb([{ numAffectedRows: 1n }]);
    expect(
      await enqueueAnnouncementFanout(s.db, {
        sourceEventId: E,
        courseId: C,
        announcementId: J,
        sendEmail: true,
      }),
    ).toBe(true);
    expect(s.statements[0]).toContain('ON CONFLICT (source_event_id) DO NOTHING');
    expect(s.statements[0]).toContain('DEFAULT)');
  });

  it('lease maps the row to a fence; attempts is the fencing token', async () => {
    const s = scriptedDb([
      {
        rows: [
          {
            id: J,
            attempts: 1,
            max_attempts: 5,
            course_id: C,
            subject_id: J,
            send_email: false,
            after_user_id: null,
            source_event_id: E,
          },
        ],
      },
    ]);
    const lease = await leaseFanoutJob(s.db, { workerId: 'worker-1' });
    expect(lease).toMatchObject({ jobId: J, attempt: 1, workerId: 'worker-1', afterUserId: null });
    expect(s.statements[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(s.parameters[0]).toEqual(['worker-1', 120_000]);
  });

  it('every batch statement is fenced on status, owner and attempts; batches need a transaction', async () => {
    const s = scriptedDb([{ rows: [] }, { numAffectedRows: 1n }]);
    await expect(lockFanoutBatch(s.db, fence)).rejects.toThrow(/transaction/);
    await s.db.transaction().execute(async (trx) => {
      expect(await lockFanoutBatch(trx, fence)).toBeNull();
      expect(await advanceFanoutJob(trx, fence, { lastUserId: C, processed: 10, done: true })).toBe(
        true,
      );
    });
    for (const q of [s.statements[1]!, s.statements[2]!]) {
      expect(q).toContain("status = 'RUNNING' AND lease_owner = $");
      expect(q).toContain('AND attempts = $');
    }
    expect(s.statements[2]).toContain("status = 'DONE', finished_at = now(), lease_owner = NULL");
  });

  it('notifications are STUDENT/ANNOUNCEMENT rows, idempotent per (user, kind, event)', async () => {
    const s = scriptedDb([{ rows: [{ user_id: C }] }]);
    const users = await insertAnnouncementNotifications(s.db, {
      sourceEventId: E,
      announcementId: J,
      userIds: [C],
      payload: { announcementId: J, redacted: false },
    });
    expect(users).toEqual([C]);
    expect(s.statements[0]).toContain("'STUDENT', 'ANNOUNCEMENT'");
    expect(s.statements[0]).toContain('ON CONFLICT (user_id, kind, source_event_id) DO NOTHING');
  });

  it('validates error codes and batch sizes before any SQL', async () => {
    const s = scriptedDb();
    await expect(failFanoutAttempt(s.db, fence, 'Bad-Code')).rejects.toThrow(RangeError);
    await expect(
      insertAnnouncementNotifications(s.db, {
        sourceEventId: E,
        announcementId: J,
        userIds: Array(1001).fill(C) as string[],
        payload: {},
      }),
    ).rejects.toThrow(RangeError);
    await expect(deleteExpiredNotifications(s.db, { batchSize: 0 })).rejects.toThrow(RangeError);
    expect(s.statements).toEqual([]);
  });
});
