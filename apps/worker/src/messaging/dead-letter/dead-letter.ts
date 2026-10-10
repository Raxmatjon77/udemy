import type { InboundRecord, RecordHeaders } from '../envelope/inbound-record';

/** Injection token for the DeadLetterPublisher implementation (Kafka in prod, fakes in tests). */
export const DEAD_LETTER_PUBLISHER = Symbol('DEAD_LETTER_PUBLISHER');

export interface DeadLetter {
  record: InboundRecord;
  error: unknown;
  attempts: number;
  /** Handler that failed; undefined when the message itself was unreadable. */
  consumerName?: string;
}

export interface DeadLetterPublisher {
  publish(deadLetter: DeadLetter): Promise<void>;
}

export interface DeadLetterMessage {
  topic: string;
  key: Buffer | null;
  value: Buffer | null;
  headers: RecordHeaders;
}

const MAX_ERROR_MESSAGE_LENGTH = 1_000;

export const DEAD_LETTER_SUFFIX = '.dlq';

/** Every header the DLQ adds starts with this; a replay strips them again. */
export const DLQ_HEADER_PREFIX = 'dlq.';

export const DLQ_HEADERS = {
  originalTopic: 'dlq.original.topic',
  originalPartition: 'dlq.original.partition',
  originalOffset: 'dlq.original.offset',
  errorName: 'dlq.error.name',
  errorMessage: 'dlq.error.message',
  attempts: 'dlq.attempts',
  failedAt: 'dlq.failed.at',
  consumer: 'dlq.consumer',
} as const;

export function deadLetterTopic(topic: string): string {
  return `${topic}${DEAD_LETTER_SUFFIX}`;
}

/**
 * The DLQ message is the original key/value/headers plus `dlq.*` headers describing the
 * failure, so it can be inspected in Kafka UI and replayed to the original topic as-is.
 */
export function buildDeadLetterMessage(
  deadLetter: DeadLetter,
  now: Date = new Date(),
): DeadLetterMessage {
  const { record, error } = deadLetter;
  const err = error instanceof Error ? error : new Error(String(error));
  const headers: RecordHeaders = {
    ...record.headers,
    [DLQ_HEADERS.originalTopic]: record.topic,
    [DLQ_HEADERS.originalPartition]: String(record.partition),
    [DLQ_HEADERS.originalOffset]: record.offset,
    [DLQ_HEADERS.errorName]: err.name,
    [DLQ_HEADERS.errorMessage]: err.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    [DLQ_HEADERS.attempts]: String(deadLetter.attempts),
    [DLQ_HEADERS.failedAt]: now.toISOString(),
  };
  if (deadLetter.consumerName !== undefined) {
    headers[DLQ_HEADERS.consumer] = deadLetter.consumerName;
  }
  return { topic: deadLetterTopic(record.topic), key: record.key, value: record.value, headers };
}
