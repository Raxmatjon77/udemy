import { Injectable } from '@nestjs/common';
import { MAX_PROGRESS_DURATION_SECONDS } from '@udemy/db';
import { InjectRedis, type RedisClient } from '../../../shared/redis';
import { type ClaimedBatch, ProgressFlushQueue } from '../application/ports/progress-flush-queue';
import type { ActivityRow, ProgressRow } from '../application/ports/progress.repository';
import {
  PROGRESS_SCRIPTS,
  RedisProgressKeys,
  runScript,
  runScriptBuffer,
} from './redis-progress.scripts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STRIDE = 8;

function text(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return typeof value === 'string' ? value : '';
}

function int(value: unknown): number | null {
  const s = text(value);
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** `{a}:{b}` of two uuids, or null. */
function idPair(rest: string): [string, string] | null {
  const [a, b, extra] = rest.split(':');
  if (a === undefined || b === undefined || extra !== undefined) return null;
  return UUID.test(a) && UUID.test(b) ? [a, b] : null;
}

/** A claimed progress snapshot -> an upsert row, or null when missing or malformed. */
function toProgressRow(member: string, fields: readonly unknown[]): ProgressRow | null {
  const ids = idPair(member.slice(2));
  if (ids === null) return null;
  const [userId, lectureId] = ids;
  const courseId = text(fields[0]);
  const mediaAssetId = text(fields[1]);
  const duration = int(fields[2]);
  const position = int(fields[3]);
  const lastMs = int(fields[4]);
  const firstMs = int(fields[5]) ?? lastMs;
  if (!UUID.test(courseId) || !UUID.test(mediaAssetId)) return null;
  if (duration === null || duration < 1 || duration > MAX_PROGRESS_DURATION_SECONDS) return null;
  if (position === null || lastMs === null || firstMs === null) return null;
  const bitmap = fields[6];
  return {
    userId,
    lectureId,
    courseId,
    mediaAssetId,
    durationSeconds: duration,
    positionSeconds: Math.min(Math.max(position, 0), duration),
    coverage: Buffer.isBuffer(bitmap) ? new Uint8Array(bitmap) : new Uint8Array(0),
    firstWatchedAt: new Date(Math.min(firstMs, lastMs)),
    lastWatchedAt: new Date(lastMs),
  };
}

/** A claimed resume pointer -> an upsert row, or null when missing or malformed. */
function toActivityRow(member: string, fields: readonly unknown[]): ActivityRow | null {
  const ids = idPair(member.slice(2));
  if (ids === null) return null;
  const lectureId = text(fields[0]);
  const atMs = int(fields[1]);
  if (!UUID.test(lectureId) || atMs === null) return null;
  return { userId: ids[0], courseId: ids[1], lectureId, accessedAt: new Date(atMs) };
}

/**
 * The flush side of the Redis write-behind buffer (`ProgressFlushQueue`): the Lua claim into a
 * per-run processing set, ack, re-queue and stale-claim recovery (see the port). Commands fail
 * with ioredis errors; the job logs them and retries on the next tick.
 */
@Injectable()
export class RedisProgressFlushQueue extends ProgressFlushQueue {
  constructor(
    @InjectRedis() private readonly redis: RedisClient,
    private readonly keys: RedisProgressKeys,
  ) {
    super();
  }

  async claim(runId: string, limit: number, nowMs: number): Promise<ClaimedBatch> {
    const reply = await runScriptBuffer(
      this.redis,
      PROGRESS_SCRIPTS.claim,
      [this.keys.dirty, this.keys.runs, this.keys.processing(runId)],
      [String(limit), String(nowMs), runId, this.keys.prefix],
    );
    if (!Array.isArray(reply) || reply.length % STRIDE !== 0) {
      throw new Error('Unexpected progress claim reply');
    }
    const progress: ProgressRow[] = [];
    const activity: ActivityRow[] = [];
    const invalid: string[] = [];
    for (let i = 0; i < reply.length; i += STRIDE) {
      const member = text(reply[i]);
      const fields = reply.slice(i + 1, i + STRIDE) as unknown[];
      if (member.startsWith('p:')) {
        const row = toProgressRow(member, fields);
        if (row === null) invalid.push(member);
        else progress.push(row);
      } else if (member.startsWith('a:')) {
        const row = toActivityRow(member, fields);
        if (row === null) invalid.push(member);
        else activity.push(row);
      } else {
        invalid.push(member);
      }
    }
    return { claimed: reply.length / STRIDE, progress, activity, invalid };
  }

  async ack(runId: string): Promise<void> {
    await this.redis.multi().del(this.keys.processing(runId)).zrem(this.keys.runs, runId).exec();
  }

  async requeue(runId: string): Promise<number> {
    return this.requeueBy('run', runId);
  }

  async recoverStale(cutoffMs: number): Promise<number> {
    return this.requeueBy('stale', String(cutoffMs));
  }

  private async requeueBy(mode: 'run' | 'stale', arg: string): Promise<number> {
    const moved = await runScript(
      this.redis,
      PROGRESS_SCRIPTS.requeue,
      [this.keys.dirty, this.keys.runs],
      [this.keys.prefix, mode, arg],
    );
    return typeof moved === 'number' ? moved : 0;
  }
}
