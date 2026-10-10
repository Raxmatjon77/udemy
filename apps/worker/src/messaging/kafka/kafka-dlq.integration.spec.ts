import { randomBytes } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listDlq, replayDlq, type CliOutput } from '../../cli/dlq/dlq-commands';
import { systemPingRecord } from '../../testing/records';
import { buildDeadLetterMessage, deadLetterTopic } from '../dead-letter/dead-letter';
import type { InboundRecord } from '../envelope/inbound-record';
import { createStderrKafkaLogger, KafkaDlqClient } from './kafka-dlq.client';

/**
 * KafkaDlqClient + the dlq:list / dlq:replay commands against a real broker (the dev stack's
 * localhost:9092, or IT_KAFKA_BROKERS), on two temporary topics `it-dlq-<random>` and its `.dlq`
 * that are deleted afterwards.
 *
 * Unreachable broker: SKIPS locally. With CI=true it FAILS, but only when IT_KAFKA_BROKERS is set:
 * the CI `test` job (.github/workflows/ci.yml) has no Kafka service, so there it skips as well.
 */
const explicitBrokers = process.env.IT_KAFKA_BROKERS?.trim();
const BROKERS = (
  explicitBrokers === undefined || explicitBrokers === '' ? 'localhost:9092' : explicitBrokers
).split(',');
const PROBE_TIMEOUT_MS = 5_000;

const EVENT_A = '0199b0a4-5c3e-7d10-8f00-00000000000a';
const EVENT_B = '0199b0a4-5c3e-7d10-8f00-00000000000b';

function quietOutput(): CliOutput & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { lines, line: (v) => lines.push(v as Record<string, unknown>), note: () => undefined };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('KafkaDlqClient (integration: Kafka)', () => {
  const suffix = randomBytes(6).toString('hex');
  const topic = `it-dlq-${suffix}`;
  const dlq = deadLetterTopic(topic);
  const groupIdPrefix = `it-dlq-cli-${suffix}`;
  let admin: KafkaJS.Admin | undefined;
  let client: KafkaDlqClient | undefined;
  let topicsCreated = false;
  let unavailable: string | undefined = 'not connected yet';

  beforeAll(async () => {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: { brokers: BROKERS, clientId: 'udemy-worker-it', logger: createStderrKafkaLogger() },
    });
    admin = kafka.admin();
    try {
      await withTimeout(admin.connect(), PROBE_TIMEOUT_MS, 'connect');
      await withTimeout(
        admin.listTopics({ timeout: PROBE_TIMEOUT_MS }),
        PROBE_TIMEOUT_MS,
        'listTopics',
      );
      unavailable = undefined;
    } catch (error) {
      unavailable = `Kafka unreachable at ${BROKERS.join(',')} (${error instanceof Error ? error.message : String(error)}). Start infra/docker/docker-compose.dev.yml.`;
      await admin.disconnect().catch(() => undefined);
      admin = undefined;
      if (process.env.CI === 'true' && explicitBrokers !== undefined && explicitBrokers !== '') {
        throw new Error(`[integration] ${unavailable}`, { cause: error });
      }
      process.stderr.write(`[integration] ${unavailable} Skipping.\n`);
      return;
    }
    await admin.createTopics({
      topics: [
        { topic, numPartitions: 3, replicationFactor: 1 },
        { topic: dlq, numPartitions: 3, replicationFactor: 1 },
      ],
    });
    topicsCreated = true;
    client = new KafkaDlqClient({
      brokers: BROKERS,
      clientId: 'udemy-worker-it',
      groupIdPrefix,
      forbiddenGroupIds: ['udemy-worker'],
      idleTimeoutMs: 15_000,
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    if (admin !== undefined) {
      if (topicsCreated) await admin.deleteTopics({ topics: [topic, dlq] }).catch(() => undefined);
      await admin.disconnect();
    }
  }, 60_000);

  function dlqMessage(eventId: string, originalPartition: number, consumer: string) {
    const record: InboundRecord = systemPingRecord({
      topic,
      partition: originalPartition,
      key: Buffer.from(`agg-${eventId.slice(-1)}`),
      headers: { ...systemPingRecord().headers, eventId: Buffer.from(eventId) },
    });
    const message = buildDeadLetterMessage({
      record,
      error: new Error('handler exploded'),
      attempts: 4,
      consumerName: consumer,
    });
    return { key: message.key, value: message.value, headers: message.headers };
  }

  async function readAll(name: string): Promise<InboundRecord[]> {
    const records: InboundRecord[] = [];
    const result = await client!.scan(name, (r) => {
      records.push(r);
      return true;
    });
    expect(result.complete).toBe(true);
    return records;
  }

  it('lists the DLQ, then replays one event and all events with the original key/value/headers', async (ctx) => {
    ctx.skip(unavailable !== undefined, unavailable);
    const c = client!;
    // Event A failed for two handlers, event B for one (written as KafkaDeadLetterPublisher does).
    await c.publish(dlq, [
      dlqMessage(EVENT_A, 1, 'HandlerOne'),
      dlqMessage(EVENT_A, 1, 'HandlerTwo'),
      dlqMessage(EVENT_B, 2, 'HandlerOne'),
    ]);

    const listed = quietOutput();
    const summary = await listDlq(c, { topic: dlq, limit: 10, previewChars: 20 }, listed);
    expect(summary).toEqual({ topic: dlq, retained: 3, listed: 3, more: false });
    expect(listed.lines.map((l) => l.eventId).sort()).toEqual([EVENT_A, EVENT_A, EVENT_B]);
    expect(listed.lines[0]).toMatchObject({
      eventType: 'SystemPing.v1',
      dlq: { originalTopic: topic, errorMessage: 'handler exploded', attempts: 4 },
      payloadPreview: expect.stringContaining('more bytes redacted'),
    });

    const dryRun = await replayDlq(
      c,
      {
        topic: dlq,
        eventId: EVENT_A,
        dryRun: true,
        allowStale: false,
        processedRetentionDays: 30,
        now: new Date(),
      },
      quietOutput(),
    );
    expect(dryRun).toMatchObject({ matched: 2, replayed: 0, skipped: { duplicate_event: 1 } });
    expect((await c.stats(topic))?.messages).toBe(0);

    const one = await replayDlq(
      c,
      {
        topic: dlq,
        eventId: EVENT_A,
        dryRun: false,
        allowStale: false,
        processedRetentionDays: 30,
        now: new Date(),
      },
      quietOutput(),
    );
    expect(one).toMatchObject({ replayed: 1 });
    const afterOne = await readAll(topic);
    expect(afterOne).toHaveLength(1);
    const replayed = afterOne[0]!;
    expect(replayed.partition).toBe(1);
    expect(replayed.key?.toString()).toBe('agg-a');
    expect(replayed.value?.toString()).toBe(systemPingRecord().value?.toString());
    expect(
      Object.fromEntries(
        Object.entries(replayed.headers).map(([k, v]) => [k, Buffer.from(v as Buffer).toString()]),
      ),
    ).toEqual({ eventId: EVENT_A, eventType: 'SystemPing.v1', aggregateType: 'system.ping' });

    const all = await replayDlq(
      c,
      {
        topic: dlq,
        eventId: undefined,
        dryRun: false,
        allowStale: false,
        processedRetentionDays: 30,
        now: new Date(),
      },
      quietOutput(),
    );
    expect(all).toMatchObject({ matched: 3, replayed: 2, skipped: { duplicate_event: 1 } });
    const afterAll_ = await readAll(topic);
    expect(afterAll_.map((r) => `${r.partition}:${r.headers.eventId?.toString()}`).sort()).toEqual([
      `1:${EVENT_A}`,
      `1:${EVENT_A}`,
      `2:${EVENT_B}`,
    ]);

    // Every scan used (and deleted) its own throw-away group; none is left behind.
    const { groups } = await admin!.listGroups();
    expect(groups.filter((g) => g.groupId.startsWith(groupIdPrefix))).toEqual([]);
  }, 180_000);
});
