import { describe, expect, it } from 'vitest';
import { EVENT_ID, systemPingRecord } from '../../testing/records';
import { EnvelopeParseError, parseEnvelope } from './parse-envelope';

describe('parseEnvelope', () => {
  it('builds the envelope from Debezium headers, key, value and timestamp', () => {
    expect(parseEnvelope(systemPingRecord())).toEqual({
      eventId: EVENT_ID,
      eventType: 'SystemPing',
      version: 1,
      aggregateType: 'system.ping',
      aggregateId: 'ping-1',
      occurredAt: '2026-10-09T12:00:01.000Z',
      payload: { message: 'hello', sentAt: '2026-10-09T12:00:00.000Z' },
    });
  });

  it('reads the version from the qualified event type', () => {
    const record = systemPingRecord({
      headers: { ...systemPingRecord().headers, eventType: 'SystemPing.v3' },
    });

    expect(parseEnvelope(record)).toMatchObject({ eventType: 'SystemPing', version: 3 });
  });

  it('accepts string and array header values', () => {
    const record = systemPingRecord({
      headers: { eventId: [EVENT_ID], eventType: 'SystemPing.v1', aggregateType: 'system.ping' },
    });

    expect(parseEnvelope(record).eventId).toBe(EVENT_ID);
  });

  it('falls back to the topic when the aggregateType header is missing', () => {
    const headers = { ...systemPingRecord().headers };
    delete headers.aggregateType;

    expect(parseEnvelope(systemPingRecord({ headers })).aggregateType).toBe('system.ping');
  });

  it.each([
    ['missing eventType header', { headers: { eventId: EVENT_ID } }],
    ['non-uuid eventId', { headers: { eventId: 'abc', eventType: 'SystemPing.v1' } }],
    ['missing key (aggregateId)', { key: null }],
    ['invalid JSON value', { value: Buffer.from('{not json') }],
    ['invalid timestamp', { timestamp: 'yesterday' }],
  ])('rejects a record with %s as non-retryable', (_case, overrides) => {
    expect(() => parseEnvelope(systemPingRecord(overrides))).toThrow(EnvelopeParseError);
  });
});
