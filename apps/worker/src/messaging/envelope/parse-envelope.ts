import { type EventEnvelope, EventEnvelopeSchema, parseEventType } from '@udemy/contracts';
import { z } from 'zod';
import { NonRetryableError } from '../non-retryable.error';
import { headerToString, type InboundRecord } from './inbound-record';

/**
 * Header names set by the Debezium Outbox EventRouter, see
 * infra/debezium/outbox-connector.json (`table.fields.additional.placement`).
 */
export const OUTBOX_HEADERS = {
  eventId: 'eventId',
  eventType: 'eventType',
  aggregateType: 'aggregateType',
} as const;

/** The message can never become valid, so it goes straight to the DLQ. */
export class EnvelopeParseError extends NonRetryableError {}

function parseJsonValue(value: Buffer | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value.toString('utf8'));
  } catch (error) {
    throw new EnvelopeParseError('Message value is not valid JSON', { cause: error });
  }
}

function timestampToIso(timestamp: string): string {
  const millis = Number(timestamp);
  if (!Number.isFinite(millis) || millis < 0) {
    throw new EnvelopeParseError(`Invalid record timestamp "${timestamp}"`);
  }
  return new Date(millis).toISOString();
}

/**
 * Builds the EventEnvelope from a Debezium outbox record:
 * - headers `eventId`, `eventType` (`SystemPing.v1`), `aggregateType`
 * - key   = aggregate id (StringConverter -> plain UTF-8)
 * - value = payload JSON (EventRouter `expand.json.payload=true`, so a JSON object, not a string)
 * - record timestamp = occurredAt
 */
export function parseEnvelope(record: InboundRecord): EventEnvelope {
  const qualifiedType = headerToString(record.headers[OUTBOX_HEADERS.eventType]);
  if (qualifiedType === undefined) {
    throw new EnvelopeParseError(`Missing "${OUTBOX_HEADERS.eventType}" header`);
  }
  const { type, version } = parseEventType(qualifiedType);

  const candidate = {
    eventId: headerToString(record.headers[OUTBOX_HEADERS.eventId]),
    eventType: type,
    // Debezium routes by aggregate type, so the topic is a safe fallback.
    aggregateType: headerToString(record.headers[OUTBOX_HEADERS.aggregateType]) ?? record.topic,
    aggregateId: record.key?.toString('utf8'),
    occurredAt: timestampToIso(record.timestamp),
    version,
    payload: parseJsonValue(record.value),
  };

  const result = EventEnvelopeSchema.safeParse(candidate);
  if (!result.success) {
    throw new EnvelopeParseError(`Invalid event envelope: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
