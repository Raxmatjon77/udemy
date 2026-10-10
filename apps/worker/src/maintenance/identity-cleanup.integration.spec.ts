import { randomUUID } from 'node:crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from '@udemy/db';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkerConfigService } from '../shared/config';
import type { WorkerEnv } from '../shared/config/worker-env.schema';
import { useIntegrationStack } from '../testing/integration';
import { IDENTITY_CLEANUP_LOCK_KEY, IdentityCleanupJob } from './identity-cleanup.job';

const CONFIG: Partial<WorkerEnv> = {
  IDENTITY_CLEANUP_GRACE_DAYS: 7,
  IDENTITY_CLEANUP_TOKEN_BATCH_SIZE: 1,
  IDENTITY_CLEANUP_SESSION_BATCH_SIZE: 1,
  IDENTITY_CLEANUP_SECURITY_EVENT_BATCH_SIZE: 1,
  IDENTITY_CLEANUP_MAX_BATCHES_PER_RUN: 50,
};

const config = {
  get: <K extends keyof WorkerEnv>(key: K): WorkerEnv[K] => CONFIG[key] as WorkerEnv[K],
} as WorkerConfigService;

describe('IdentityCleanupJob (integration: Postgres)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];

  afterAll(async () => {
    if (it_.unavailableReason !== undefined || userIds.length === 0) return;
    await it_.db.deleteFrom('identity.oneTimeTokens').where('userId', 'in', userIds).execute();
    await it_.db.deleteFrom('identity.users').where('id', 'in', userIds).execute();
  });

  async function userWithTokens(): Promise<{ userId: string; expired: string[]; live: string }> {
    const user = await it_.db
      .insertInto('identity.users')
      .values({
        email: `it-cleanup-${randomUUID()}@example.test`,
        displayName: 'Cleanup IT',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$aW50ZWdyYXRpb24$aW50ZWdyYXRpb24',
        passwordChangedAt: sql<Date>`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userIds.push(user.id);
    const insert = (
      purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
      daysAgo: number,
      live: boolean,
    ) =>
      it_.db
        .insertInto('identity.oneTimeTokens')
        .values({
          userId: user.id,
          purpose,
          tokenHash: Buffer.from(randomUUID().replaceAll('-', '').repeat(2), 'hex'),
          email: 'cleanup@example.test',
          sourceEventId: randomUUID(),
          requestedAt: sql<Date>`now() - make_interval(days => ${daysAgo + 1}::int)`,
          expiresAt: sql<Date>`now() - make_interval(days => ${daysAgo}::int)`,
          invalidatedAt: live ? null : sql<Date>`now()`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    // Two expired more than 7 days ago (one per purpose), one that is not yet past the grace.
    const a = await insert('EMAIL_VERIFICATION', 9, false);
    const b = await insert('PASSWORD_RESET', 8, true);
    const c = await insert('EMAIL_VERIFICATION', 3, true);
    return { userId: user.id, expired: [a.id, b.id], live: c.id };
  }

  const exists = async (ids: string[]): Promise<number> =>
    (
      await it_.db
        .selectFrom('identity.oneTimeTokens')
        .select('id')
        .where('id', 'in', ids)
        .execute()
    ).length;

  it('deletes expired one-time tokens batch by batch and keeps rows inside the grace period', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const { expired, live } = await userWithTokens();
    const job = new IdentityCleanupJob(it_.db, config, new SchedulerRegistry());

    const result = await job.runOnce();

    expect(result.status).toBe('completed');
    expect(result.deleted.one_time_tokens).toBeGreaterThanOrEqual(2);
    expect(await exists(expired)).toBe(0);
    expect(await exists([live])).toBe(1);
  }, 60_000);

  it('stops without deleting anything while another replica holds the advisory lock', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const { expired } = await userWithTokens();
    const job = new IdentityCleanupJob(it_.db, config, new SchedulerRegistry());

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const otherReplica = it_.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${IDENTITY_CLEANUP_LOCK_KEY}::bigint)`.execute(trx);
      locked();
      await held;
    });
    await lockTaken;

    try {
      const result = await job.runOnce();
      expect(result.status).toBe('locked');
      expect(await exists(expired)).toBe(2);
    } finally {
      release();
      await otherReplica;
    }
  }, 60_000);
});
