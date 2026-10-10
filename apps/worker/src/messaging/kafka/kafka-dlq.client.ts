import { randomBytes } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { DlqClient, OutboundRecord, ScanResult, TopicStats } from '../dead-letter/dlq-client';
import type { InboundRecord } from '../envelope/inbound-record';
import { toInboundRecord } from './kafka-record';

export interface KafkaDlqClientOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  /** Throw-away group ids are `<prefix>-<random>`; one per scan. */
  readonly groupIdPrefix: string;
  /** Group ids a scan must never use (the worker's shared group). */
  readonly forbiddenGroupIds: readonly string[];
  /** A scan gives up after this long without a new message (default 30 s). */
  readonly idleTimeoutMs?: number;
  /** Client logs; defaults to warn/error as JSON lines on stderr (stdout is for results). */
  readonly logger?: KafkaJS.Logger;
}

/** warn/error only, to stderr: the CLI's stdout carries nothing but its JSON lines. */
export function createStderrKafkaLogger(): KafkaJS.Logger {
  const write = (level: string, message: string, extra?: object): void => {
    process.stderr.write(`${JSON.stringify({ level, source: 'kafka', message, ...extra })}\n`);
  };
  const logger: KafkaJS.Logger = {
    info: () => undefined,
    debug: () => undefined,
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    namespace: () => logger,
    setLogLevel: () => undefined,
  };
  return logger;
}

/**
 * DlqClient over @confluentinc/kafka-javascript for the worker CLI.
 *
 * Reading: the KafkaJS-compatible consumer has no manual `assign()`, so every scan subscribes
 * with a FRESH consumer group (`<prefix>-<random hex>`, `fromBeginning`, `autoCommit: false`):
 * it starts at the low watermark, commits nothing, and is deleted afterwards. The worker's group
 * is never joined or moved, so a scan can run while the worker is consuming.
 */
export class KafkaDlqClient implements DlqClient {
  private readonly kafka: KafkaJS.Kafka;
  private admin: Promise<KafkaJS.Admin> | undefined;
  private producer: Promise<KafkaJS.Producer> | undefined;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: KafkaDlqClientOptions) {
    this.kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: [...options.brokers],
        clientId: options.clientId,
        logger: options.logger ?? createStderrKafkaLogger(),
      },
    });
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  }

  async stats(topic: string): Promise<TopicStats | undefined> {
    const admin = await this.adminClient();
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) return undefined;
    const offsets = await admin.fetchTopicOffsets(topic);
    const messages = offsets.reduce((sum, o) => sum + (BigInt(o.high) - BigInt(o.low)), 0n);
    return { partitions: offsets.length, messages: Number(messages) };
  }

  async scan(topic: string, visit: (record: InboundRecord) => boolean): Promise<ScanResult> {
    const admin = await this.adminClient();
    // Snapshot of the end: messages appended during the scan are not visited.
    const lastOffset = new Map<number, bigint>();
    for (const w of await admin.fetchTopicOffsets(topic)) {
      const high = BigInt(w.high);
      if (high > BigInt(w.low)) lastOffset.set(w.partition, high - 1n);
    }
    if (lastOffset.size === 0) return { scanned: 0, complete: true };

    const groupId = this.newGroupId();
    const consumer = this.kafka.consumer({
      kafkaJS: { groupId, fromBeginning: true, autoCommit: false },
    });
    let scanned = 0;
    let finished = false;
    let visitError: unknown;
    let idleTimer: NodeJS.Timeout | undefined;
    let finish: (complete: boolean) => void = () => undefined;
    const done = new Promise<boolean>((resolve) => {
      finish = (complete) => {
        if (finished) return;
        finished = true;
        clearTimeout(idleTimer);
        resolve(complete);
      };
    });
    const armIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(false), this.idleTimeoutMs);
    };

    try {
      await consumer.connect();
      await consumer.subscribe({ topics: [topic] });
      armIdle();
      await consumer.run({
        eachMessage: async ({ partition, message }) => {
          if (finished) return;
          const last = lastOffset.get(partition);
          if (last === undefined) return;
          const offset = BigInt(message.offset);
          if (offset <= last) {
            armIdle();
            scanned += 1;
            let keepGoing: boolean;
            try {
              keepGoing = visit(toInboundRecord(topic, partition, message));
            } catch (error) {
              visitError = error;
              finish(false);
              return;
            }
            if (!keepGoing) {
              finish(false);
              return;
            }
          }
          if (offset >= last) lastOffset.delete(partition);
          if (lastOffset.size === 0) finish(true);
        },
      });
      const complete = await done;
      if (visitError !== undefined) throw visitError;
      return { scanned, complete };
    } finally {
      finish(false);
      await consumer.disconnect().catch(() => undefined);
      // Nothing was committed, so the group is empty; delete it so no trace is left.
      await admin.deleteGroups([groupId]).catch(() => undefined);
    }
  }

  async publish(topic: string, records: readonly OutboundRecord[]): Promise<void> {
    const producer = await this.producerClient();
    await producer.send({
      topic,
      messages: records.map((r) => ({
        key: r.key,
        value: r.value,
        headers: r.headers,
        ...(r.partition === undefined ? {} : { partition: r.partition }),
      })),
    });
  }

  async close(): Promise<void> {
    const clients = [this.producer, this.admin];
    this.producer = undefined;
    this.admin = undefined;
    for (const client of clients) {
      if (client === undefined) continue;
      await client.then((c) => c.disconnect()).catch(() => undefined);
    }
  }

  private newGroupId(): string {
    const groupId = `${this.options.groupIdPrefix}-${randomBytes(6).toString('hex')}`;
    if (this.options.forbiddenGroupIds.includes(groupId)) {
      throw new Error(`Refusing to read with consumer group ${groupId}`);
    }
    return groupId;
  }

  private adminClient(): Promise<KafkaJS.Admin> {
    this.admin ??= (async () => {
      const admin = this.kafka.admin();
      await admin.connect();
      return admin;
    })();
    return this.admin;
  }

  private producerClient(): Promise<KafkaJS.Producer> {
    this.producer ??= (async () => {
      // Idempotent: a retried send is deduplicated by the broker (no double replay per send).
      const producer = this.kafka.producer({ kafkaJS: { idempotent: true } });
      await producer.connect();
      return producer;
    })();
    return this.producer;
  }
}
