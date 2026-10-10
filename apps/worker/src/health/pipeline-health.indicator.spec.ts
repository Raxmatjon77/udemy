import type { Database } from '@udemy/nest-common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplicationSlotState } from '../maintenance/replication-slot';
import type {
  ConsumerLagReporter,
  ConsumerLagSnapshot,
} from '../messaging/kafka/consumer-lag.reporter';
import type { WorkerConfigService } from '../shared/config';
import type { WorkerEnv } from '../shared/config/worker-env.schema';
import { PipelineHealthIndicator } from './pipeline-health.indicator';

const SLOT: ReplicationSlotState = {
  slotName: 'udemy_outbox',
  active: true,
  catalogXmin: '100',
  confirmedFlushLsn: '0/1',
  lagBytes: 2048,
  walStatus: 'reserved',
};

function indicator(
  env: Partial<WorkerEnv>,
  slot: ReplicationSlotState | undefined | Error,
  lag?: ConsumerLagSnapshot,
): PipelineHealthIndicator {
  const ENV: Partial<WorkerEnv> = {
    OUTBOX_REPLICATION_SLOT: 'udemy_outbox',
    DEBEZIUM_CONNECTOR_NAME: 'udemy-outbox',
    ...env,
  };
  const config = {
    get: <K extends keyof WorkerEnv>(key: K): WorkerEnv[K] => ENV[key] as WorkerEnv[K],
  } as WorkerConfigService;
  const reporter = { lastSnapshot: () => lag } as unknown as ConsumerLagReporter;
  const result = new PipelineHealthIndicator({} as Database, config, reporter);
  vi.spyOn(result, 'readSlot').mockImplementation(async () => {
    if (slot instanceof Error) throw slot;
    return slot;
  });
  return result;
}

function stubConnect(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const running = {
  name: 'udemy-outbox',
  connector: { state: 'RUNNING' },
  tasks: [{ id: 0, state: 'RUNNING' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PipelineHealthIndicator', () => {
  it('is up with connector, slot lag and the last consumer lag sample', async () => {
    stubConnect(running);
    const lag: ConsumerLagSnapshot = {
      at: '2026-10-10T12:00:00.000Z',
      groupId: 'udemy-worker',
      totalLag: 3,
      topics: [
        { topic: 'system.ping', lag: 3, partitions: [] },
        { topic: 'x', error: 'boom' },
      ],
    };

    const result = await indicator({ KAFKA_CONNECT_URL: 'http://localhost:8083' }, SLOT, lag).check(
      'pipeline',
    );

    expect(result.pipeline).toEqual({
      status: 'up',
      connector: {
        ok: true,
        connector: 'udemy-outbox',
        state: 'RUNNING',
        tasks: [{ id: 0, state: 'RUNNING' }],
      },
      replicationSlot: {
        name: 'udemy_outbox',
        active: true,
        walStatus: 'reserved',
        lagBytes: 2048,
      },
      consumerLag: {
        at: '2026-10-10T12:00:00.000Z',
        total: 3,
        topics: { 'system.ping': 3, x: null },
      },
    });
  });

  it('skips the connector check when KAFKA_CONNECT_URL is unset', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await indicator({}, SLOT).check('pipeline');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.pipeline).toMatchObject({
      status: 'up',
      connector: { skipped: 'KAFKA_CONNECT_URL is not set' },
      consumerLag: null,
    });
  });

  it('is degraded (never down) with a clear message when a connector task FAILED', async () => {
    stubConnect({
      ...running,
      tasks: [{ id: 0, state: 'FAILED', trace: 'java.lang.IllegalStateException: boom\n\tat x' }],
    });

    const result = await indicator({ KAFKA_CONNECT_URL: 'http://localhost:8083' }, SLOT).check(
      'pipeline',
    );

    expect(result.pipeline.status).toBe('degraded');
    expect(result.pipeline.message).toBe(
      'Debezium task 0 is FAILED (java.lang.IllegalStateException: boom): restart it: POST /connectors/udemy-outbox/restart?includeTasks=true&onlyFailed=true',
    );
  });

  it.each([
    [undefined, 'Replication slot udemy_outbox does not exist'],
    [{ ...SLOT, active: false }, 'Replication slot udemy_outbox is not active'],
    [{ ...SLOT, walStatus: 'lost' }, 'Replication slot udemy_outbox is lost'],
    [new Error('connection refused'), 'Replication slot state unavailable'],
  ])('is degraded for slot %#', async (slot, message) => {
    const result = await indicator({}, slot).check('pipeline');

    expect(result.pipeline.status).toBe('degraded');
    expect(result.pipeline.message).toContain(message);
  });

  it('joins several problems into one message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const result = await indicator({ KAFKA_CONNECT_URL: 'http://localhost:8083' }, undefined).check(
      'pipeline',
    );

    expect(result.pipeline.message).toBe(
      'Kafka Connect is unreachable (TypeError) | Replication slot udemy_outbox does not exist (Debezium creates it on its first start)',
    );
  });
});
