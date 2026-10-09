import type { InboundRecord } from '../messaging/envelope/inbound-record';

export const EVENT_ID = '0199b0a4-5c3e-7d10-8f00-2a1b3c4d5e6f';

/** A record exactly as Debezium's outbox EventRouter produces it for a SystemPing. */
export function systemPingRecord(overrides: Partial<InboundRecord> = {}): InboundRecord {
  return {
    topic: 'system.ping',
    partition: 0,
    offset: '42',
    key: Buffer.from('ping-1'),
    value: Buffer.from(JSON.stringify({ message: 'hello', sentAt: '2026-10-09T12:00:00.000Z' })),
    headers: {
      eventId: Buffer.from(EVENT_ID),
      eventType: Buffer.from('SystemPing.v1'),
      aggregateType: Buffer.from('system.ping'),
    },
    timestamp: String(Date.UTC(2026, 9, 9, 12, 0, 1)),
    ...overrides,
  };
}
