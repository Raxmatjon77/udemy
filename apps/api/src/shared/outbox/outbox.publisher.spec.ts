import { SystemPing } from '@udemy/contracts';
import { type DB, insertOutboxEvent, type Transaction } from '@udemy/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxPayloadError } from './outbox-payload.error';
import { OutboxPublisher } from './outbox.publisher';

// Replace only the DB write; everything else in @udemy/db stays real.
vi.mock('@udemy/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@udemy/db')>()),
  insertOutboxEvent: vi.fn(async () => ({ id: '0199b0a4-0000-7000-8000-000000000001' })),
}));

/** Enough of a Transaction for the publisher; the actual insert is mocked above. */
function fakeTransaction(isTransaction = true): Transaction<DB> {
  return { isTransaction } as unknown as Transaction<DB>;
}

describe('OutboxPublisher', () => {
  const publisher = new OutboxPublisher();
  const validPayload = { message: 'hello', sentAt: '2026-10-09T12:00:00.000Z' };

  beforeEach(() => {
    vi.mocked(insertOutboxEvent).mockClear();
  });

  it('writes a valid event with the versioned type and the aggregate type as topic', async () => {
    const trx = fakeTransaction();

    await expect(publisher.publish(trx, SystemPing, 'agg-1', validPayload)).resolves.toEqual({
      id: '0199b0a4-0000-7000-8000-000000000001',
    });
    expect(insertOutboxEvent).toHaveBeenCalledWith(trx, {
      aggregateType: 'system.ping',
      aggregateId: 'agg-1',
      type: 'SystemPing.v1',
      payload: validPayload,
    });
  });

  it('rejects a payload that breaks the event contract and writes nothing', async () => {
    const invalid = { message: '', sentAt: 'yesterday' };

    await expect(
      publisher.publish(fakeTransaction(), SystemPing, 'agg-1', invalid),
    ).rejects.toThrow(OutboxPayloadError);
    expect(insertOutboxEvent).not.toHaveBeenCalled();
  });

  it('refuses to run outside a transaction', async () => {
    await expect(
      publisher.publish(fakeTransaction(false), SystemPing, 'agg-1', validPayload),
    ).rejects.toThrow(/inside the caller transaction/);
    expect(insertOutboxEvent).not.toHaveBeenCalled();
  });
});
