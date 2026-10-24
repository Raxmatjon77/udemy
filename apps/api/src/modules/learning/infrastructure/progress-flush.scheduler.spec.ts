import { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlushReport, ProgressFlushJob } from '../application/progress-flush.job';
import { testSettings } from '../application/testing/learning.fakes';
import { PROGRESS_FLUSH_INTERVAL_NAME, ProgressFlushScheduler } from './progress-flush.scheduler';

const REPORT: FlushReport = {
  locked: true,
  claimed: 3,
  written: 2,
  activities: 1,
  dropped: 0,
  recovered: 0,
};

function fakeJob(drain: () => Promise<FlushReport> = () => Promise.resolve(REPORT)) {
  return { drain: vi.fn(drain) };
}

describe('ProgressFlushScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when LEARNING_JOBS_ENABLED=false (no timer, no final flush)', async () => {
    const registry = new SchedulerRegistry();
    const job = fakeJob();
    const scheduler = new ProgressFlushScheduler(
      job as unknown as ProgressFlushJob,
      testSettings({ jobsEnabled: false }),
      registry,
    );
    scheduler.onApplicationBootstrap();
    expect(registry.doesExist('interval', PROGRESS_FLUSH_INTERVAL_NAME)).toBe(false);
    await scheduler.beforeApplicationShutdown('SIGTERM');
    expect(job.drain).not.toHaveBeenCalled();
  });

  it('drains every LEARNING_PROGRESS_FLUSH_INTERVAL_MS (fake timers)', async () => {
    vi.useFakeTimers();
    const registry = new SchedulerRegistry();
    const job = fakeJob();
    const scheduler = new ProgressFlushScheduler(
      job as unknown as ProgressFlushJob,
      testSettings({ flushIntervalMs: 15_000 }),
      registry,
    );
    scheduler.onApplicationBootstrap();
    expect(registry.doesExist('interval', PROGRESS_FLUSH_INTERVAL_NAME)).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(job.drain).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(job.drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(job.drain).toHaveBeenCalledTimes(3);
    await scheduler.beforeApplicationShutdown();
  });

  it('never overlaps ticks, and a failing tick is logged, not thrown', async () => {
    let release!: () => void;
    const job = fakeJob(
      () =>
        new Promise<FlushReport>((resolve) => {
          release = () => resolve(REPORT);
        }),
    );
    const scheduler = new ProgressFlushScheduler(
      job as unknown as ProgressFlushJob,
      testSettings(),
      new SchedulerRegistry(),
    );
    const first = scheduler.tick();
    const second = scheduler.tick();
    expect(job.drain).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);

    job.drain.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('on shutdown (SIGTERM): stops the timer, waits for the running tick, then flushes once more', async () => {
    const registry = new SchedulerRegistry();
    const order: string[] = [];
    let release!: () => void;
    const job = fakeJob();
    job.drain
      .mockImplementationOnce(
        () =>
          new Promise<FlushReport>((resolve) => {
            release = () => {
              order.push('tick done');
              resolve(REPORT);
            };
          }),
      )
      .mockImplementationOnce(() => {
        order.push('final flush');
        return Promise.resolve(REPORT);
      });
    const scheduler = new ProgressFlushScheduler(
      job as unknown as ProgressFlushJob,
      testSettings(),
      registry,
    );
    scheduler.onApplicationBootstrap();
    void scheduler.tick();
    const shutdown = scheduler.beforeApplicationShutdown('SIGTERM');
    expect(registry.doesExist('interval', PROGRESS_FLUSH_INTERVAL_NAME)).toBe(false);
    release();
    await shutdown;
    expect(order).toEqual(['tick done', 'final flush']);
    expect(job.drain).toHaveBeenCalledTimes(2);
  });

  it('a failing final flush does not fail the shutdown', async () => {
    const job = fakeJob(() => Promise.reject(new Error('redis gone')));
    const scheduler = new ProgressFlushScheduler(
      job as unknown as ProgressFlushJob,
      testSettings(),
      new SchedulerRegistry(),
    );
    scheduler.onApplicationBootstrap();
    await expect(scheduler.beforeApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
  });
});
