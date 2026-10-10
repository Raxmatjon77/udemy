import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export interface JobSettings {
  /** `transcode_jobs.lease_owner` / `transcode_attempts.worker_id` of this process. */
  readonly workerId: string;
  readonly leaseMs: number;
  /** LEASE_MS / 3. */
  readonly heartbeatIntervalMs: number;
  readonly tmpDir: string;
  /** TRANSCODER_MAX_ATTEMPTS: no retry once a job reached this many attempts. */
  readonly maxAttempts: number;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
}

export const JOB_SETTINGS = Symbol.for('udemy.transcoder.JOB_SETTINGS');

/** `transcoder:{host}:{pid}:{random}`, at most 128 characters (`transcode_jobs_lease_owner_ck`). */
export function createWorkerId(): string {
  const host = hostname()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 64);
  return `transcoder:${host}:${process.pid}:${randomBytes(4).toString('hex')}`;
}
