import { describe, expect, it } from 'vitest';
import { buildDeadLetterMessage } from '../../messaging/dead-letter/dead-letter';
import type {
  DlqClient,
  OutboundRecord,
  ScanResult,
  TopicStats,
} from '../../messaging/dead-letter/dlq-client';
import type { InboundRecord } from '../../messaging/envelope/inbound-record';
import { EVENT_ID, systemPingRecord } from '../../testing/records';
import { CliUsageError } from '../cli-usage.error';
import {
  CliCommandError,
  type CliOutput,
  describeDlqRecord,
  listDlq,
  originalTopicOf,
  payloadPreview,
  replayDlq,
  type ReplayOptions,
  stripDlqHeaders,
} from './dlq-commands';

/** In-memory DlqClient for the command tests: topics are arrays of partitions of records. */
class FakeDlqClient implements DlqClient {
  readonly topics = new Map<string, InboundRecord[][]>();
  readonly published: { topic: string; records: OutboundRecord[] }[] = [];
  closed = false;

  createTopic(topic: string, partitions: number): void {
    this.topics.set(
      topic,
      Array.from({ length: partitions }, () => []),
    );
  }

  /** Appends a record (offset assigned per partition) and returns it. */
  append(
    topic: string,
    partition: number,
    record: Omit<InboundRecord, 'topic' | 'partition' | 'offset'>,
  ): InboundRecord {
    const partitions = this.topics.get(topic);
    const log = partitions?.[partition];
    if (log === undefined) throw new Error(`No partition ${partition} in ${topic}`);
    const full: InboundRecord = { ...record, topic, partition, offset: String(log.length) };
    log.push(full);
    return full;
  }

  async stats(topic: string): Promise<TopicStats | undefined> {
    const partitions = this.topics.get(topic);
    if (partitions === undefined) return undefined;
    return {
      partitions: partitions.length,
      messages: partitions.reduce((sum, p) => sum + p.length, 0),
    };
  }

  async scan(topic: string, visit: (record: InboundRecord) => boolean): Promise<ScanResult> {
    const snapshot = (this.topics.get(topic) ?? []).map((p) => [...p]);
    let scanned = 0;
    for (const partition of snapshot) {
      for (const record of partition) {
        scanned += 1;
        if (!visit(record)) return { scanned, complete: false };
      }
    }
    return { scanned, complete: true };
  }

  async publish(topic: string, records: readonly OutboundRecord[]): Promise<void> {
    if (!this.topics.has(topic)) throw new Error(`Unknown topic ${topic}`);
    this.published.push({ topic, records: [...records] });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const OTHER_EVENT = '0199b0a4-5c3e-7d10-8f00-000000000002';

function output(): CliOutput & { lines: unknown[]; notes: string[] } {
  const lines: unknown[] = [];
  const notes: string[] = [];
  return { lines, notes, line: (v) => lines.push(v), note: (m) => notes.push(m) };
}

/** A DLQ message exactly as KafkaDeadLetterPublisher writes it. */
function deadLetter(
  o: {
    eventId?: string;
    partition?: number;
    failedAt?: Date;
    consumer?: string;
    value?: Buffer;
  } = {},
): Omit<InboundRecord, 'topic' | 'partition' | 'offset'> {
  const original = systemPingRecord({
    partition: o.partition ?? 2,
    offset: '42',
    ...(o.value === undefined ? {} : { value: o.value }),
    headers: {
      ...systemPingRecord().headers,
      eventId: Buffer.from(o.eventId ?? EVENT_ID),
    },
  });
  const message = buildDeadLetterMessage(
    {
      record: original,
      error: new Error('SMTP down'),
      attempts: 4,
      consumerName: o.consumer ?? 'DebugEventHandler',
    },
    o.failedAt ?? new Date(NOW.getTime() - DAY_MS),
  );
  return {
    key: message.key,
    value: message.value,
    headers: message.headers,
    timestamp: String(NOW.getTime() - DAY_MS),
  };
}

function setup(): FakeDlqClient {
  const client = new FakeDlqClient();
  client.createTopic('system.ping', 3);
  client.createTopic('system.ping.dlq', 3);
  return client;
}

const replayOptions = (o: Partial<ReplayOptions> = {}): ReplayOptions => ({
  topic: 'system.ping.dlq',
  eventId: undefined,
  dryRun: false,
  allowStale: false,
  processedRetentionDays: 30,
  now: NOW,
  ...o,
});

describe('helpers', () => {
  it('maps a DLQ topic to its original topic and refuses anything else', () => {
    expect(originalTopicOf('identity.user.dlq')).toBe('identity.user');
    expect(() => originalTopicOf('identity.user')).toThrow(CliUsageError);
    expect(() => originalTopicOf('.dlq')).toThrow(CliUsageError);
    expect(() => originalTopicOf('identity.user.dlq.dlq')).toThrow(/DLQ of a DLQ/);
  });

  it('previews short payloads in full and redacts the rest of long ones', () => {
    expect(payloadPreview(Buffer.from('{"a":1}'), 200)).toBe('{"a":1}');
    expect(payloadPreview(null, 10)).toBeNull();
    expect(payloadPreview(Buffer.from('x'.repeat(250)), 200)).toBe(
      `${'x'.repeat(200)}… [50 more bytes redacted]`,
    );
  });

  it('strips exactly the dlq.* headers', () => {
    expect(
      stripDlqHeaders({
        eventId: 'a',
        'dlq.error.name': 'Error',
        'dlq.attempts': '3',
        dlqx: 'keep',
      }),
    ).toEqual({ eventId: 'a', dlqx: 'keep' });
  });
});

describe('listDlq', () => {
  it('prints offset, key, event headers, dlq.* error headers and a payload preview', async () => {
    const client = setup();
    client.append('system.ping.dlq', 0, deadLetter());
    const out = output();

    const summary = await listDlq(
      client,
      { topic: 'system.ping.dlq', limit: 20, previewChars: 200 },
      out,
    );

    expect(summary).toEqual({ topic: 'system.ping.dlq', retained: 1, listed: 1, more: false });
    expect(out.lines).toEqual([
      {
        partition: 0,
        offset: '0',
        timestamp: new Date(NOW.getTime() - DAY_MS).toISOString(),
        key: 'ping-1',
        eventType: 'SystemPing.v1',
        eventId: EVENT_ID,
        dlq: {
          originalTopic: 'system.ping',
          originalPartition: '2',
          originalOffset: '42',
          consumer: 'DebugEventHandler',
          errorName: 'Error',
          errorMessage: 'SMTP down',
          attempts: 4,
          failedAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
        },
        payloadBytes: 55,
        payloadPreview: '{"message":"hello","sentAt":"2026-10-09T12:00:00.000Z"}',
      },
    ]);
  });

  it('stops at --limit and says there is more', async () => {
    const client = setup();
    for (let i = 0; i < 5; i += 1) client.append('system.ping.dlq', i % 3, deadLetter());
    const out = output();

    const summary = await listDlq(
      client,
      { topic: 'system.ping.dlq', limit: 2, previewChars: 10 },
      out,
    );

    expect(summary).toMatchObject({ retained: 5, listed: 2, more: true });
    expect(out.lines).toHaveLength(2);
  });

  it('fails clearly for a missing topic and refuses a non-DLQ topic', async () => {
    const client = setup();
    await expect(
      listDlq(client, { topic: 'nope.dlq', limit: 1, previewChars: 1 }, output()),
    ).rejects.toThrow(new CliCommandError('Topic nope.dlq does not exist'));
    await expect(
      listDlq(client, { topic: 'system.ping', limit: 1, previewChars: 1 }, output()),
    ).rejects.toThrow(CliUsageError);
  });

  it('describes a message without any headers', () => {
    const record: InboundRecord = {
      topic: 't.dlq',
      partition: 0,
      offset: '7',
      key: null,
      value: null,
      headers: {},
      timestamp: 'not-a-number',
    };
    expect(describeDlqRecord(record, 10)).toMatchObject({
      key: null,
      eventId: null,
      timestamp: null,
      payloadBytes: 0,
      payloadPreview: null,
      dlq: { attempts: null, errorName: null },
    });
  });
});

describe('replayDlq', () => {
  it('republishes the original key, value and headers (minus dlq.*) to the original partition', async () => {
    const client = setup();
    const dlq = client.append('system.ping.dlq', 1, deadLetter({ partition: 2 }));
    const out = output();

    const summary = await replayDlq(client, replayOptions({ eventId: EVENT_ID }), out);

    expect(summary).toEqual({
      topic: 'system.ping.dlq',
      targetTopic: 'system.ping',
      dryRun: false,
      matched: 1,
      replayed: 1,
      skipped: {},
    });
    const original = systemPingRecord();
    expect(client.published).toEqual([
      {
        topic: 'system.ping',
        records: [
          {
            key: dlq.key,
            value: original.value,
            headers: { ...original.headers, eventId: Buffer.from(EVENT_ID) },
            partition: 2,
          },
        ],
      },
    ]);
    expect(Object.keys(client.published[0]?.records[0]?.headers ?? {})).toEqual([
      'eventId',
      'eventType',
      'aggregateType',
    ]);
  });

  it('--dry-run publishes nothing but prints what it would do', async () => {
    const client = setup();
    client.append('system.ping.dlq', 0, deadLetter());
    const out = output();

    const summary = await replayDlq(client, replayOptions({ dryRun: true }), out);

    expect(summary).toMatchObject({ dryRun: true, matched: 1, replayed: 0 });
    expect(client.published).toEqual([]);
    expect(out.lines).toEqual([
      expect.objectContaining({ action: 'would_replay', eventId: EVENT_ID, targetPartition: 2 }),
    ]);
  });

  it('--all replays each event once, skips unreadable and stale messages', async () => {
    const client = setup();
    // Same event failed for two handlers on the topic: one republish re-runs both.
    client.append('system.ping.dlq', 0, deadLetter({ consumer: 'A' }));
    client.append('system.ping.dlq', 0, deadLetter({ consumer: 'B' }));
    client.append('system.ping.dlq', 1, deadLetter({ eventId: OTHER_EVENT }));
    // Unreadable message: the dispatcher DLQs it without an eventId header.
    client.append('system.ping.dlq', 2, {
      key: null,
      value: Buffer.from('not json'),
      headers: { 'dlq.original.topic': 'system.ping', 'dlq.error.name': 'EnvelopeParseError' },
      timestamp: String(NOW.getTime()),
    });
    // Failed 31 days ago: older than PROCESSED_EVENTS_RETENTION_DAYS.
    client.append(
      'system.ping.dlq',
      2,
      deadLetter({
        eventId: '0199b0a4-5c3e-7d10-8f00-000000000003',
        failedAt: new Date(NOW.getTime() - 31 * DAY_MS),
      }),
    );
    const out = output();

    const summary = await replayDlq(client, replayOptions(), out);

    expect(summary).toMatchObject({
      matched: 5,
      replayed: 2,
      skipped: { duplicate_event: 1, no_event_id: 1, stale: 1 },
    });
    expect(client.published[0]?.records).toHaveLength(2);
    expect(out.notes[0]).toContain('--allow-stale');
  });

  it('--allow-stale replays stale messages too', async () => {
    const client = setup();
    client.append(
      'system.ping.dlq',
      0,
      deadLetter({ failedAt: new Date(NOW.getTime() - 400 * DAY_MS) }),
    );

    const summary = await replayDlq(client, replayOptions({ allowStale: true }), output());

    expect(summary).toMatchObject({ replayed: 1, skipped: {} });
  });

  it('skips a message whose dlq.original.topic is another topic', async () => {
    const client = setup();
    const message = deadLetter();
    client.append('system.ping.dlq', 0, {
      ...message,
      headers: { ...message.headers, 'dlq.original.topic': 'identity.user' },
    });

    const summary = await replayDlq(client, replayOptions(), output());

    expect(summary).toMatchObject({ replayed: 0, skipped: { other_topic: 1 } });
    expect(client.published).toEqual([]);
  });

  it('lets the partitioner choose when the original partition does not exist', async () => {
    const client = setup();
    client.append('system.ping.dlq', 0, deadLetter({ partition: 7 }));

    await replayDlq(client, replayOptions(), output());

    expect(client.published[0]?.records[0]).not.toHaveProperty('partition');
  });

  it('fails when --event-id matches nothing, or a topic is missing', async () => {
    const client = setup();
    client.append('system.ping.dlq', 0, deadLetter());

    await expect(
      replayDlq(client, replayOptions({ eventId: OTHER_EVENT }), output()),
    ).rejects.toThrow(`No message with eventId ${OTHER_EVENT} in system.ping.dlq`);
    client.topics.delete('system.ping');
    await expect(replayDlq(client, replayOptions(), output())).rejects.toThrow(
      'Original topic system.ping does not exist',
    );
    expect(client.published).toEqual([]);
  });
});
