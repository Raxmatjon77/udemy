import { describe, expect, it } from 'vitest';
import { systemPingRecord } from '../../testing/records';
import { buildDeadLetterMessage } from './dead-letter';

describe('buildDeadLetterMessage', () => {
  it('keeps the original message and adds dlq.* error headers', () => {
    const record = systemPingRecord();
    const message = buildDeadLetterMessage(
      { record, error: new TypeError('boom'), attempts: 4, consumerName: 'TestHandler' },
      new Date('2026-10-09T12:00:05.000Z'),
    );

    expect(message).toMatchObject({
      topic: 'system.ping.dlq',
      key: record.key,
      value: record.value,
    });
    expect(message.headers).toMatchObject({
      ...record.headers,
      'dlq.original.topic': 'system.ping',
      'dlq.original.partition': '0',
      'dlq.original.offset': '42',
      'dlq.error.name': 'TypeError',
      'dlq.error.message': 'boom',
      'dlq.attempts': '4',
      'dlq.consumer': 'TestHandler',
      'dlq.failed.at': '2026-10-09T12:00:05.000Z',
    });
  });
});
