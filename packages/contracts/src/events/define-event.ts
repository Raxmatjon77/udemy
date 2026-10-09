import type { z } from 'zod';
import type { EventEnvelope } from './event-envelope';
import { qualifyEventType } from './event-type';

export interface EventDefinitionOptions {
  /**
   * Aggregate the event belongs to. Debezium routes on it, so it is also the Kafka
   * topic name (e.g. `catalog.course`). Use `<context>.<aggregate>`.
   */
  aggregateType: string;
}

/** A typed, versioned event contract shared by the producer (api) and consumers (worker). */
export interface EventDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly version: number;
  readonly aggregateType: string;
  /** Value stored in `outbox.events.type` and sent as the `eventType` header. */
  readonly qualifiedType: string;
  readonly payloadSchema: TSchema;
  /** Validates and returns the payload; throws a ZodError when invalid. */
  parsePayload(payload: unknown): z.output<TSchema>;
  /** Non-throwing variant of `parsePayload`. */
  safeParsePayload(payload: unknown): z.ZodSafeParseResult<z.output<TSchema>>;
  /** True when the envelope carries this event type and version. */
  matches(envelope: Pick<EventEnvelope, 'eventType' | 'version'>): boolean;
}

/** Payload type of an event definition, e.g. `EventPayload<typeof SystemPing>`. */
export type EventPayload<TDef extends EventDefinition> = z.output<TDef['payloadSchema']>;

/** Input type of an event definition (before defaults/transforms are applied). */
export type EventPayloadInput<TDef extends EventDefinition> = z.input<TDef['payloadSchema']>;

export function defineEvent<TSchema extends z.ZodType>(
  type: string,
  version: number,
  payloadSchema: TSchema,
  options: EventDefinitionOptions,
): EventDefinition<TSchema> {
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`Event version must be a positive integer, got ${version}`);
  }
  return Object.freeze({
    type,
    version,
    aggregateType: options.aggregateType,
    qualifiedType: qualifyEventType(type, version),
    payloadSchema,
    parsePayload: (payload: unknown) => payloadSchema.parse(payload),
    safeParsePayload: (payload: unknown) => payloadSchema.safeParse(payload),
    matches: (envelope: Pick<EventEnvelope, 'eventType' | 'version'>) =>
      envelope.eventType === type && envelope.version === version,
  });
}
