import type { EventEnvelope } from '@udemy/contracts';
import type { DB, PostRefundInput, PostResult, PostSaleInput, Transaction } from '@udemy/db';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { FAKE_TRX } from '../../identity/testing/identity-mail.fakes';
import { MessageDispatcher } from '../../messaging/message-dispatcher';
import { NonRetryableError } from '../../messaging';
import type { DeadLetter } from '../../messaging/dead-letter/dead-letter';
import type { EventHandlerRegistry } from '../../messaging/event-handler.registry';
import { IdempotentEventProcessor } from '../../messaging/idempotency/idempotent-event-processor';
import { createFakeDatabase } from '../../testing/fake-database';
import { classifyLedgerError, isSaleMissing, LedgerSaleMissingError } from '../ledger-errors';
import { LedgerJournal } from '../ledger-journal';
import { LedgerRefundWriterHandler, LedgerSaleWriterHandler } from './ledger-writer.handlers';

const ORDER = '0199c8a0-0000-7000-8000-0000000000b1';
const LINE_A = '0199c8a0-0000-7000-8000-0000000000a1';
const LINE_B = '0199c8a0-0000-7000-8000-0000000000a2';
const REFUND = '0199c8a0-0000-7000-8000-0000000000b3';
const COURSE = '0199c8a0-0000-7000-8000-0000000000c1';
const BUYER = '0199c8a0-0000-7000-8000-000000000001';
const INSTRUCTOR = '0199c8a0-0000-7000-8000-000000000002';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = '2026-10-10T10:00:00.000Z';

const line = (orderLineId: string, finalAmount: string, instructor: string, platform: string) => ({
  orderLineId,
  courseId: COURSE,
  instructorId: INSTRUCTOR,
  courseTitle: 'Rust',
  listAmount: finalAmount,
  discountAmount: '0.00',
  finalAmount,
  couponId: null,
  couponCode: null,
  revenueShareBps: 7000,
  instructorShareAmount: instructor,
  platformShareAmount: platform,
});

const orderPaid = (lines = [line(LINE_A, '49.99', '34.99', '15.00')]): EventEnvelope => ({
  eventId: EVENT,
  eventType: 'OrderPaid',
  aggregateType: 'commerce.order',
  aggregateId: ORDER,
  occurredAt: NOW,
  version: 1,
  payload: {
    orderId: ORDER,
    orderNumber: 7,
    userId: BUYER,
    currency: 'USD',
    totalAmount: '49.99',
    provider: 'STRIPE',
    paidAt: NOW,
    lines,
  },
});

const refundSucceeded = (overrides: Record<string, unknown> = {}): EventEnvelope => ({
  eventId: EVENT,
  eventType: 'RefundSucceeded',
  aggregateType: 'commerce.order',
  aggregateId: ORDER,
  occurredAt: NOW,
  version: 1,
  payload: {
    refundId: REFUND,
    orderId: ORDER,
    orderLineId: LINE_A,
    userId: BUYER,
    courseId: COURSE,
    instructorId: INSTRUCTOR,
    currency: 'USD',
    amount: '49.99',
    instructorShareAmount: '34.99',
    platformShareAmount: '15.00',
    succeededAt: NOW,
    ...overrides,
  },
});

/** A Postgres error as node-postgres raises it (code + constraint). */
function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error(`violates ${constraint}`), { code, constraint });
}

class FakeJournal extends LedgerJournal {
  readonly calls: string[] = [];
  readonly sales: PostSaleInput[] = [];
  readonly refunds: PostRefundInput[] = [];
  saleOutcome: (input: PostSaleInput) => PostResult = () => ({
    outcome: 'POSTED',
    entryId: 'e1',
  });
  refundOutcome: () => PostResult = () => ({ outcome: 'POSTED', entryId: 'e2' });
  checkError: unknown = undefined;
  paid: boolean | null = true;

  override async postSale(_trx: Transaction<DB>, input: PostSaleInput): Promise<PostResult> {
    this.calls.push(`sale:${input.orderLineId}`);
    this.sales.push(input);
    return this.saleOutcome(input);
  }
  override async postRefund(_trx: Transaction<DB>, input: PostRefundInput): Promise<PostResult> {
    this.calls.push(`refund:${input.orderLineId}`);
    this.refunds.push(input);
    return this.refundOutcome();
  }
  override async checkNow(): Promise<void> {
    this.calls.push('check');
    if (this.checkError !== undefined) throw this.checkError;
  }
  override async orderWasPaid(_trx: Transaction<DB>, orderId: string): Promise<boolean | null> {
    this.calls.push(`paid?:${orderId}`);
    return this.paid;
  }
}

describe('LedgerSaleWriterHandler', () => {
  it('posts one SALE per line from the payload (business time paidAt), then checks the balance', async () => {
    const journal = new FakeJournal();
    await new LedgerSaleWriterHandler(journal).handle(
      orderPaid([line(LINE_A, '49.99', '34.99', '15.00'), line(LINE_B, '19.99', '13.99', '6.00')]),
      FAKE_TRX,
    );
    expect(journal.calls).toEqual([`sale:${LINE_A}`, `sale:${LINE_B}`, 'check']);
    expect(journal.sales[0]).toEqual({
      orderLineId: LINE_A,
      sourceEventId: EVENT,
      occurredAt: new Date(NOW),
      currency: 'USD',
      instructorId: INSTRUCTOR,
      finalAmount: '49.99',
      instructorShareAmount: '34.99',
      platformShareAmount: '15.00',
    });
  });

  it('ZERO_AMOUNT and ALREADY_POSTED lines are skipped without failing', async () => {
    const journal = new FakeJournal();
    journal.saleOutcome = (input) =>
      input.finalAmount === '0.00'
        ? { outcome: 'ZERO_AMOUNT', entryId: null }
        : { outcome: 'ALREADY_POSTED', entryId: 'e1' };
    await expect(
      new LedgerSaleWriterHandler(journal).handle(
        orderPaid([line(LINE_A, '0.00', '0.00', '0.00'), line(LINE_B, '19.99', '13.99', '6.00')]),
        FAKE_TRX,
      ),
    ).resolves.toBeUndefined();
  });

  it('an unbalanced entry is dead-lettered at once (NonRetryableError)', async () => {
    const journal = new FakeJournal();
    journal.checkError = pgError('23514', 'postings_balanced_ck');
    await expect(
      new LedgerSaleWriterHandler(journal).handle(orderPaid(), FAKE_TRX),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('dead-letters a broken payload (ZodError)', async () => {
    await expect(
      new LedgerSaleWriterHandler(new FakeJournal()).handle(
        orderPaid([line(LINE_A, '49.9', '34.99', '15.00')]),
        FAKE_TRX,
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe('LedgerRefundWriterHandler', () => {
  it('posts the mirror REFUND (business time succeededAt) and checks it', async () => {
    const journal = new FakeJournal();
    await new LedgerRefundWriterHandler(journal).handle(refundSucceeded(), FAKE_TRX);
    expect(journal.calls).toEqual([`paid?:${ORDER}`, `refund:${LINE_A}`, 'check']);
    expect(journal.refunds[0]).toEqual({
      orderLineId: LINE_A,
      refundId: REFUND,
      sourceEventId: EVENT,
      occurredAt: new Date(NOW),
    });
  });

  it('a missing SALE becomes a retryable LedgerSaleMissingError', async () => {
    const journal = new FakeJournal();
    journal.refundOutcome = () => {
      throw pgError('23514', 'journal_entries_sale_missing_ck');
    };
    const error = await new LedgerRefundWriterHandler(journal)
      .handle(refundSucceeded(), FAKE_TRX)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerSaleMissingError);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect((error as LedgerSaleMissingError).orderLineId).toBe(LINE_A);
  });

  it('ALREADY_POSTED and LINE_ALREADY_REVERSED are logged and skipped (no check, no throw)', async () => {
    for (const outcome of ['ALREADY_POSTED', 'LINE_ALREADY_REVERSED'] as const) {
      const journal = new FakeJournal();
      journal.refundOutcome = () => ({ outcome, entryId: null });
      await new LedgerRefundWriterHandler(journal).handle(refundSucceeded(), FAKE_TRX);
      expect(journal.calls).toEqual([`paid?:${ORDER}`, `refund:${LINE_A}`]);
    }
  });

  it('an order that was never PAID (or does not exist) posts nothing', async () => {
    for (const paid of [false, null]) {
      const journal = new FakeJournal();
      journal.paid = paid;
      await new LedgerRefundWriterHandler(journal).handle(refundSucceeded(), FAKE_TRX);
      expect(journal.calls).toEqual([`paid?:${ORDER}`]);
    }
  });

  it('a REFUND that is not the mirror of its SALE is dead-lettered at once', async () => {
    const journal = new FakeJournal();
    journal.checkError = pgError('23514', 'journal_entries_mirror_ck');
    await expect(
      new LedgerRefundWriterHandler(journal).handle(refundSucceeded(), FAKE_TRX),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe('ledger error classification', () => {
  it('recognises the sale-missing guard and the permanent invariants only', () => {
    expect(isSaleMissing(pgError('23514', 'journal_entries_sale_missing_ck'))).toBe(true);
    expect(isSaleMissing(pgError('23505', 'journal_entries_sale_missing_ck'))).toBe(false);
    expect(isSaleMissing(new Error('boom'))).toBe(false);
    expect(classifyLedgerError(pgError('23503', 'postings_account_id_currency_fk'))).toBeInstanceOf(
      NonRetryableError,
    );
    const transient = Object.assign(new Error('connection reset'), { code: '08006' });
    expect(classifyLedgerError(transient)).toBe(transient);
    const otherCheck = pgError('23514', 'some_other_ck');
    expect(classifyLedgerError(otherCheck)).toBe(otherCheck);
  });
});

describe('ledger writer under the dispatcher (out-of-order delivery)', () => {
  function setup(handle: (envelope: EventEnvelope) => Promise<void>) {
    const { db } = createFakeDatabase();
    const registered = {
      topic: 'commerce.order',
      eventType: 'RefundSucceeded',
      consumerName: 'payouts.ledger-writer.refund-succeeded',
      handler: { handle },
    };
    const registry = {
      handlersFor: () => [registered],
    } as unknown as EventHandlerRegistry;
    const deadLetters: DeadLetter[] = [];
    const dispatcher = new MessageDispatcher(
      registry,
      new IdempotentEventProcessor(db),
      { publish: async (dl) => void deadLetters.push(dl) },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    );
    return { dispatcher, deadLetters };
  }

  const record = () => ({
    topic: 'commerce.order',
    partition: 0,
    offset: '1',
    key: Buffer.from(ORDER),
    value: Buffer.from(JSON.stringify(refundSucceeded().payload)),
    headers: {
      eventId: Buffer.from(EVENT),
      eventType: Buffer.from('RefundSucceeded.v1'),
      aggregateType: Buffer.from('commerce.order'),
    },
    timestamp: String(Date.parse(NOW)),
  });

  it('retries a missing SALE and succeeds once the SALE is there', async () => {
    let attempts = 0;
    const handle = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new LedgerSaleMissingError(LINE_A, REFUND);
    });
    const { dispatcher, deadLetters } = setup(handle);
    await dispatcher.dispatch(record());
    expect(handle).toHaveBeenCalledTimes(3);
    expect(deadLetters).toHaveLength(0);
  });

  it('dead-letters after the retry budget when the SALE never arrives', async () => {
    const handle = vi.fn(async () => {
      throw new LedgerSaleMissingError(LINE_A, REFUND);
    });
    const { dispatcher, deadLetters } = setup(handle);
    await dispatcher.dispatch(record());
    expect(handle).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
    expect(deadLetters).toEqual([
      expect.objectContaining({
        attempts: 3,
        consumerName: 'payouts.ledger-writer.refund-succeeded',
        error: expect.any(LedgerSaleMissingError),
      }),
    ]);
  });
});
