/** A Kafka header value as delivered by the client (KafkaJS-compatible shape). */
export type HeaderValue = Buffer | string | (Buffer | string)[];

export type RecordHeaders = Record<string, HeaderValue | undefined>;

/**
 * Transport-neutral view of one consumed Kafka message. Everything below the Kafka adapter
 * works with this type, so it can be tested without a broker or the native client.
 */
export interface InboundRecord {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
  headers: RecordHeaders;
  /** Record timestamp, epoch milliseconds as a string. */
  timestamp: string;
}

/** First value of a header as UTF-8 text; undefined when absent or empty. */
export function headerToString(value: HeaderValue | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return undefined;
  const text = typeof first === 'string' ? first : first.toString('utf8');
  return text.length > 0 ? text : undefined;
}
