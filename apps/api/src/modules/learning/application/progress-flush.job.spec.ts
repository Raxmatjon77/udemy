import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARTICLE,
  COURSE,
  type LearningHarness,
  learningHarness,
  STUDENT,
  testSettings,
  VIDEO,
} from './testing/learning.fakes';

async function watch(h: LearningHarness, from: number, to: number): Promise<void> {
  h.clock.advance(to - from);
  await h.heartbeat.execute({
    userId: STUDENT,
    courseId: COURSE,
    lectureId: VIDEO,
    positionSeconds: to,
    ranges: [{ from, to }],
  });
}

describe('ProgressFlushJob (claim / ack / re-queue / recovery)', () => {
  let h: LearningHarness;
  beforeEach(() => {
    h = learningHarness();
  });

  it('writes the claimed snapshots in one batch and acks the claim', async () => {
    await watch(h, 0, 30);
    const report = await h.flushJob.flushOnce();
    expect(report).toEqual({
      locked: true,
      claimed: 2, // the progress member and the resume pointer
      written: 1,
      activities: 1,
      dropped: 0,
      recovered: 0,
    });
    const row = h.progressRepo.rows.get(`${STUDENT}:${VIDEO}`);
    expect(row).toMatchObject({ positionSeconds: 30, durationSeconds: 100, courseId: COURSE });
    expect(h.progressRepo.activities.get(`${STUDENT}:${COURSE}`)?.lectureId).toBe(VIDEO);
    expect(h.buffer.dirty.size).toBe(0);
    expect(h.buffer.processing.size).toBe(0);
    expect(h.buffer.runs.size).toBe(0);
  });

  it('claims nothing when another replica holds the _06 lock (taken BEFORE the claim)', async () => {
    await watch(h, 0, 30);
    h.progressRepo.lockHeld = true;
    const report = await h.flushJob.flushOnce();
    expect(report.locked).toBe(false);
    expect(h.buffer.dirty.size).toBe(2);
    expect(h.buffer.processing.size).toBe(0);
    expect(h.progressRepo.batches).toBe(0);
  });

  it('re-queues the claim when the DB write fails: no heartbeat is lost', async () => {
    await watch(h, 0, 30);
    h.progressRepo.failWrites = new Error('connection reset');
    await expect(h.flushJob.flushOnce()).rejects.toThrow('connection reset');
    expect(h.buffer.dirty.size).toBe(2);
    expect(h.buffer.processing.size).toBe(0);

    h.progressRepo.failWrites = null;
    await h.flushJob.flushOnce();
    expect(h.progressRepo.rows.get(`${STUDENT}:${VIDEO}`)?.positionSeconds).toBe(30);
  });

  it('re-queues the claim when the COMMIT fails after the write', async () => {
    await watch(h, 0, 30);
    h.tx.failNextCommit = new Error('could not serialize');
    await expect(h.flushJob.flushOnce()).rejects.toThrow('could not serialize');
    expect(h.buffer.dirty.size).toBe(2);
  });

  it("recovers a crashed flusher's claim (neither acked nor re-queued) on a later run", async () => {
    await watch(h, 0, 30);
    h.progressRepo.failWrites = new Error('db down');
    h.queue.failRequeue = new Error('redis down too');
    await expect(h.flushJob.flushOnce()).rejects.toThrow('db down');
    expect(h.buffer.dirty.size).toBe(0);
    expect(h.buffer.processing.size).toBe(1); // stranded

    h.progressRepo.failWrites = null;
    // Not yet stale: a live flusher's claim is never taken over.
    const early = await h.flushJob.flushOnce();
    expect(early.recovered).toBe(0);
    expect(h.buffer.processing.size).toBe(1);

    h.clock.advance(61);
    const late = await h.flushJob.flushOnce();
    expect(late.recovered).toBe(2);
    expect(late.written).toBe(1);
    expect(h.buffer.processing.size).toBe(0);
    expect(h.queue.cutoffs.at(-1)).toBe(h.clock.ms - h.settings.staleClaimMs);
  });

  it('keeps a committed batch even when the ack fails (a later recovery re-flushes, harmlessly)', async () => {
    await watch(h, 0, 30);
    h.queue.failAck = new Error('redis blip');
    const report = await h.flushJob.flushOnce();
    expect(report.written).toBe(1);
    expect(h.buffer.processing.size).toBe(1);
    h.clock.advance(61);
    await h.flushJob.flushOnce();
    // re-flushing the same state changes nothing
    expect(h.progressRepo.rows.get(`${STUDENT}:${VIDEO}`)?.positionSeconds).toBe(30);
    expect(h.buffer.processing.size).toBe(0);
  });

  it('a heartbeat between claim and ack re-dirties the member: its bits reach the next flush', async () => {
    await watch(h, 0, 30);
    const writeBatch = h.progressRepo.writeBatch.bind(h.progressRepo);
    const spy = vi
      .spyOn(h.progressRepo, 'writeBatch')
      .mockImplementationOnce(async (trx, progress, activity) => {
        await watch(h, 30, 60); // lands while the batch is being written
        return writeBatch(trx, progress, activity);
      });
    await h.flushJob.flushOnce();
    expect(h.progressRepo.rows.get(`${STUDENT}:${VIDEO}`)?.positionSeconds).toBe(30);
    expect(h.buffer.dirty.has(`p:${STUDENT}:${VIDEO}`)).toBe(true);
    spy.mockRestore();
    await h.flushJob.flushOnce();
    const stored = await h.progressRepo.listCourseProgress(STUDENT, COURSE);
    expect(stored[0]).toMatchObject({ positionSeconds: 60, coveredBuckets: 12 });
  });

  it('drops (and logs) rows the DB rejects, keeping the rest of the batch', async () => {
    await watch(h, 0, 30);
    h.progressRepo.rejectKeys.add(`${STUDENT}:${VIDEO}`);
    const report = await h.flushJob.flushOnce();
    expect(report).toMatchObject({ written: 0, dropped: 1, activities: 1 });
    expect(h.buffer.processing.size).toBe(0);
  });

  it('drops claimed members without a snapshot (expired keys)', async () => {
    await watch(h, 0, 30);
    h.buffer.entries.clear();
    const report = await h.flushJob.flushOnce();
    expect(report).toMatchObject({ claimed: 2, written: 0, dropped: 1, activities: 1 });
  });

  it('drain repeats full batches and stops at a partial one', async () => {
    h = learningHarness({ settings: testSettings({ flushBatchSize: 1 }) });
    await watch(h, 0, 30);
    await h.complete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: ARTICLE,
      cause: 'MANUAL',
    });
    const report = await h.flushJob.drain(10);
    expect(report.claimed).toBe(2);
    expect(h.progressRepo.batches).toBe(2);
    expect(h.buffer.dirty.size).toBe(0);
  });

  it('drain gives up at once when the lock is busy', async () => {
    await watch(h, 0, 30);
    h.progressRepo.lockHeld = true;
    expect((await h.flushJob.drain()).locked).toBe(false);
  });
});
