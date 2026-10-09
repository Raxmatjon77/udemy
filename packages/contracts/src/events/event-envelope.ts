import { z } from 'zod';

/**
 * What every consumer receives, regardless of transport.
 * The worker assembles it from Kafka headers (eventId, eventType, aggregateType),
 * the message key (aggregateId), the record timestamp (occurredAt) and the JSON value (payload).
 */
export const EventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  /** Logical type without the version suffix, e.g. `SystemPing`. */
  eventType: z.string().min(1),
  /** Also the Kafka topic (Debezium routes by aggregate_type), e.g. `catalog.course`. */
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  version: z.number().int().positive(),
  payload: z.unknown(),
});

export type EventEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof EventEnvelopeSchema>,
  'payload'
> & { payload: TPayload };
