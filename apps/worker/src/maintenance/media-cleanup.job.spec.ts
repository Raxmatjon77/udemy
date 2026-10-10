import { SchedulerRegistry } from '@nestjs/schedule';
import type { Database } from '@udemy/nest-common';
import type { ObjectStorage } from '@udemy/storage';
import { describe, expect, it } from 'vitest';
import type { WorkerConfigService } from '../shared/config';
import type { WorkerEnv } from '../shared/config/worker-env.schema';
import { MediaCleanupJob } from './media-cleanup.job';
import type { MediaCleanupStep, StepResult } from './media-cleanup.steps';

const ENV: Partial<WorkerEnv> = {
  MEDIA_CLEANUP_ENABLED: true,
  MEDIA_CLEANUP_BATCH_SIZE: 100,
  MEDIA_CLEANUP_MAX_BATCHES_PER_RUN: 5,
  MEDIA_UPLOAD_TTL_HOURS: 24,
  MEDIA_UNATTACHED_GRACE_HOURS: 24,
  MEDIA_UNUSED_GRACE_DAYS: 7,
  MEDIA_SOURCE_RETENTION_DAYS: 1,
};
const config = {
  get: <K extends keyof WorkerEnv>(key: K): WorkerEnv[K] => ENV[key] as WorkerEnv[K],
} as WorkerConfigService;

function job(): MediaCleanupJob {
  return new MediaCleanupJob({} as Database, {} as ObjectStorage, config, new SchedulerRegistry());
}

function step(name: string, result: StepResult, ran: string[]): MediaCleanupStep {
  return {
    name,
    async run(ctx) {
      ran.push(name);
      expect(ctx.maxBatches).toBe(5);
      return result;
    },
  };
}

describe('MediaCleanupJob.runOnce', () => {
  it('maps the env to step options (retention from MEDIA_SOURCE_RETENTION_DAYS)', () => {
    expect(job().options()).toEqual({
      batchSize: 100,
      uploadTtlHours: 24,
      neverUsedGraceHours: 24,
      releasedGraceDays: 7,
      sourceRetentionDays: 1,
    });
  });

  it('runs every step and prefixes the counters with the step name', async () => {
    const ran: string[] = [];
    const result = await job().runOnce([
      step('a', { status: 'completed', counts: { x: 2 }, s3Failures: 1 }, ran),
      step('b', { status: 'completed', counts: { y: 3 }, s3Failures: 0 }, ran),
    ]);
    expect(ran).toEqual(['a', 'b']);
    expect(result).toEqual({ status: 'completed', counts: { 'a.x': 2, 'b.y': 3 }, s3Failures: 1 });
  });

  it('stops at the first step that finds the lock taken', async () => {
    const ran: string[] = [];
    const result = await job().runOnce([
      step('a', { status: 'locked', counts: { x: 0 }, s3Failures: 0 }, ran),
      step('b', { status: 'completed', counts: {}, s3Failures: 0 }, ran),
    ]);
    expect(ran).toEqual(['a']);
    expect(result.status).toBe('locked');
  });

  it('does not start steps once shutdown began', async () => {
    const ran: string[] = [];
    const j = job();
    await j.beforeApplicationShutdown();
    const result = await j.runOnce([
      step('a', { status: 'completed', counts: {}, s3Failures: 0 }, ran),
    ]);
    expect(ran).toEqual([]);
    expect(result.status).toBe('completed');
  });
});
