import type { InboundRecord, RecordHeaders } from '../envelope/inbound-record';

/** A message to publish (replay): the original key/value/headers, optionally a fixed partition. */
export interface OutboundRecord {
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: RecordHeaders;
  readonly partition?: number;
}

export interface TopicStats {
  readonly partitions: number;
  /** Σ (high - low) over the partitions: messages currently retained. */
  readonly messages: number;
}

export interface ScanResult {
  readonly scanned: number;
  /** False when reading stopped before every partition reached its end (visitor or idle timeout). */
  readonly complete: boolean;
}

/**
 * What the DLQ CLI needs from Kafka, so the commands are testable with an in-memory fake.
 * Implemented by KafkaDlqClient (messaging/kafka), which reads through a throw-away consumer
 * group per invocation and never touches the worker's `udemy-worker` group.
 */
export interface DlqClient {
  /** undefined when the topic does not exist. */
  stats(topic: string): Promise<TopicStats | undefined>;
  /**
   * Visits the messages present when the call starts (up to the high watermarks taken then),
   * partition by partition in offset order, without committing anything. Stops early when
   * `visit` returns false.
   */
  scan(topic: string, visit: (record: InboundRecord) => boolean): Promise<ScanResult>;
  publish(topic: string, records: readonly OutboundRecord[]): Promise<void>;
  close(): Promise<void>;
}
