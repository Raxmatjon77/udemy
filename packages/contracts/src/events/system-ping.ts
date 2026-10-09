import { z } from 'zod';
import { defineEvent, type EventPayload } from './define-event';

/** Example event used to smoke-test the outbox -> Debezium -> Kafka -> worker pipeline. */
export const SystemPing = defineEvent(
  'SystemPing',
  1,
  z.object({
    message: z.string().min(1).max(500),
    sentAt: z.iso.datetime({ offset: true }),
  }),
  { aggregateType: 'system.ping' },
);

export type SystemPingPayload = EventPayload<typeof SystemPing>;
