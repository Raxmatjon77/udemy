import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerConfigService } from '../../shared/config';
import type { WorkerEnv } from '../../shared/config/worker-env.schema';
import type { EventHandlerRegistry } from '../event-handler.registry';
import { fetchConsumerLag, type LagAdmin, partitionLag } from './consumer-lag';
import { ConsumerLagReporter } from './consumer-lag.reporter';

type Watermarks = Awaited<ReturnType<LagAdmin['fetchTopicOffsets']>>;

/** fetchTopicOffsets entry (`offset` is the high watermark, as in the client). */
const wm = (partition: number, low: string, high: string): Watermarks[number] => ({
  partition,
  offset: high,
  low,
  high,
});

function fakeAdmin(
  watermarks: Record<string, Watermarks>,
  committed: Record<string, Record<number, string>>,
) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fetchOffsets: vi.fn(async ({ topics }: { groupId: string; topics?: unknown }) =>
      (topics as string[]).map((topic) => ({
        topic,
        partitions: Object.entries(committed[topic] ?? {}).map(([p, offset]) => ({
          partition: Number(p),
          offset,
          metadata: null,
          leaderEpoch: null,
          error: null,
        })),
      })),
    ),
    fetchTopicOffsets: vi.fn(async (topic: string) => {
      const w = watermarks[topic];
      if (w === undefined) throw new Error(`Unknown topic ${topic}`);
      return w;
    }),
  };
}

describe('partitionLag', () => {
  it('is high minus the committed offset', () => {
    expect(partitionLag(0, { low: '0', high: '10' }, '7')).toMatchObject({
      committed: '7',
      lag: 3,
    });
  });

  it('counts from the low watermark when nothing was committed (-1)', () => {
    expect(partitionLag(1, { low: '4', high: '10' }, '-1')).toMatchObject({
      committed: null,
      lag: 6,
    });
    expect(partitionLag(1, { low: '0', high: '0' }, undefined).lag).toBe(0);
  });

  it('never goes below zero and ignores a commit older than retention', () => {
    expect(partitionLag(0, { low: '5', high: '10' }, '2').lag).toBe(5);
    expect(partitionLag(0, { low: '0', high: '10' }, '10').lag).toBe(0);
  });
});

describe('fetchConsumerLag', () => {
  it('sums the partitions per topic and reports a failing topic without hiding the others', async () => {
    const admin = fakeAdmin(
      {
        'identity.user': [wm(1, '0', '5'), wm(0, '0', '12')],
      },
      { 'identity.user': { 0: '10', 1: '-1' } },
    );

    const lag = await fetchConsumerLag(admin, 'udemy-worker', ['identity.user', 'missing.topic']);

    expect(admin.fetchOffsets).toHaveBeenCalledWith({
      groupId: 'udemy-worker',
      topics: ['identity.user', 'missing.topic'],
    });
    expect(lag).toEqual([
      {
        topic: 'identity.user',
        lag: 7,
        partitions: [
          { partition: 0, committed: '10', low: '0', high: '12', lag: 2 },
          { partition: 1, committed: null, low: '0', high: '5', lag: 5 },
        ],
      },
      { topic: 'missing.topic', error: 'Unknown topic missing.topic' },
    ]);
  });
});

describe('ConsumerLagReporter', () => {
  const ENV: Partial<WorkerEnv> = {
    KAFKA_GROUP_ID: 'udemy-worker',
    PIPELINE_METRICS_INTERVAL_MS: 0,
  };
  const config = {
    get: <K extends keyof WorkerEnv>(key: K): WorkerEnv[K] => ENV[key] as WorkerEnv[K],
  } as WorkerConfigService;
  const registry = { topics: () => ['system.ping'] } as unknown as EventHandlerRegistry;

  it('connects once, keeps the latest sample and disconnects on shutdown', async () => {
    const admin = fakeAdmin({ 'system.ping': [wm(0, '0', '3')] }, { 'system.ping': { 0: '1' } });
    const reporter = new ConsumerLagReporter(admin as unknown as KafkaJS.Admin, registry, config);
    reporter.onApplicationBootstrap(); // interval 0: no timer

    expect(reporter.lastSnapshot()).toBeUndefined();
    await reporter.sample();
    const snapshot = await reporter.sample();

    expect(admin.connect).toHaveBeenCalledOnce();
    expect(snapshot).toMatchObject({ groupId: 'udemy-worker', totalLag: 2 });
    expect(reporter.lastSnapshot()).toBe(snapshot);
    await reporter.beforeApplicationShutdown();
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });

  it('retries the connection on the next sample after a failed connect', async () => {
    const admin = fakeAdmin({ 'system.ping': [wm(0, '0', '0')] }, {});
    admin.connect.mockRejectedValueOnce(new Error('broker down'));
    const reporter = new ConsumerLagReporter(admin as unknown as KafkaJS.Admin, registry, config);

    await expect(reporter.sample()).rejects.toThrow('broker down');
    await expect(reporter.sample()).resolves.toMatchObject({ totalLag: 0 });
    expect(admin.connect).toHaveBeenCalledTimes(2);
  });
});
