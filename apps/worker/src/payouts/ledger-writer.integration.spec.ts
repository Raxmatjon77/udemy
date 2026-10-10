import { SchedulerRegistry } from '@nestjs/schedule';
import type { EventEnvelope } from '@udemy/contracts';
import { reconcileLedger, sql } from '@udemy/db';
import { createCoupon, deleteTestData } from '@udemy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeConfig } from '../identity/testing/identity-mail.fakes';
import { LedgerReconciliationJob } from '../maintenance/ledger-reconciliation.job';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import {
  commerceEnvelope,
  orderPaidPayload,
  refundSucceededPayload,
  type SeededOrder,
  seedPaidOrder,
  seedSucceededRefund,
} from '../testing/commerce-fixtures';
import { insertTestUser, useIntegrationStack } from '../testing/integration';
import {
  LedgerRefundWriterHandler,
  LedgerSaleWriterHandler,
} from './handlers/ledger-writer.handlers';
import { LedgerSaleMissingError } from './ledger-errors';
import { LedgerJournal } from './ledger-journal';

/**
 * `payouts.ledger-writer` against the dev Postgres with the real idempotent processor (the
 * claim in outbox.processed_events and the ledger writes share one transaction). Orders are
 * seeded with the `@udemy/db/testing` commerce fixtures; events are built in memory with
 * `it.`-prefixed consumer names, so a running worker never sees them. Every check is scoped to
 * this file's order lines (the database is shared).
 */
describe('payouts.ledger-writer (integration: Postgres)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];
  const eventIds: string[] = [];
  const lineIds: string[] = [];
  let processor: IdempotentEventProcessor;
  let sale: RegisteredEventHandler;
  let refund: RegisteredEventHandler;

  beforeAll(() => {
    if (it_.unavailableReason !== undefined) return;
    const journal = new LedgerJournal();
    sale = {
      topic: 'commerce.order',
      eventType: 'OrderPaid',
      consumerName: 'it.payouts.ledger-writer.order-paid',
      handler: new LedgerSaleWriterHandler(journal),
    };
    refund = {
      topic: 'commerce.order',
      eventType: 'RefundSucceeded',
      consumerName: 'it.payouts.ledger-writer.refund-succeeded',
      handler: new LedgerRefundWriterHandler(journal),
    };
    processor = new IdempotentEventProcessor(it_.db);
  });

  afterAll(async () => {
    if (it_.unavailableReason !== undefined) return;
    if (eventIds.length > 0) {
      await it_.db.deleteFrom('outbox.processedEvents').where('eventId', 'in', eventIds).execute();
    }
    // commerce, enrollment and payouts rows of these users (postings, entries, their accounts)
    await deleteTestData(it_.db, userIds);
  });

  async function user(tag: string): Promise<string> {
    const created = await insertTestUser(it_.db, { tag });
    userIds.push(created.id);
    return created.id;
  }

  async function order(lines: { listAmount: string; couponId?: string }[]): Promise<SeededOrder> {
    const buyer = await user('buyer');
    const instructor = await user('instructor');
    const seeded = await seedPaidOrder(it_.db, {
      buyerId: buyer,
      lines: lines.map((l, i) => ({
        ...l,
        instructorId: instructor,
        courseTitle: `IT ledger ${i}`,
      })),
    });
    lineIds.push(...seeded.lines.map((l) => l.id));
    return seeded;
  }

  function track(envelope: EventEnvelope): EventEnvelope {
    eventIds.push(envelope.eventId);
    return envelope;
  }

  const orderPaid = (o: SeededOrder) =>
    track(commerceEnvelope('OrderPaid', o.orderId, orderPaidPayload(o)));

  interface Leg {
    kind: string;
    type: string;
    ownerId: string | null;
    amount: string;
  }

  async function legs(orderLineIds: string[]): Promise<Leg[]> {
    const { rows } = await sql<Leg>`
      SELECT e.kind, a.type, a.owner_id, p.amount
        FROM payouts.journal_entries e
        JOIN payouts.postings p ON p.entry_id = e.id
        JOIN payouts.accounts a ON a.id = p.account_id
       WHERE e.order_line_id = ANY(${orderLineIds}::uuid[])
       ORDER BY e.kind DESC, e.order_line_id, p.line_no
    `.execute(it_.db);
    return rows;
  }

  async function entryCount(orderLineIds: string[]): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM payouts.journal_entries WHERE order_line_id = ANY(${orderLineIds}::uuid[])
    `.execute(it_.db);
    return rows[0]?.n ?? 0;
  }

  async function claimed(consumer: string, eventId: string): Promise<boolean> {
    const row = await it_.db
      .selectFrom('outbox.processedEvents')
      .select('eventId')
      .where('consumer', '=', consumer)
      .where('eventId', '=', eventId)
      .executeTakeFirst();
    return row !== undefined;
  }

  it('OrderPaid posts one balanced SALE per paid line (lazy accounts); a 0.00 line gets none', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const owner = await user('coupon-owner');
    const freeCoupon = await createCoupon(it_.db, { createdBy: owner, percentOff: 100 });
    const o = await order([{ listAmount: '49.99' }, { listAmount: '19.99', couponId: freeCoupon }]);
    const [paidLine, freeLine] = o.lines;
    expect(freeLine?.finalAmount).toBe('0.00');

    await expect(processor.process(sale, orderPaid(o))).resolves.toBe('processed');

    const instructor = paidLine!.instructorId;
    expect(await legs([paidLine!.id, freeLine!.id])).toEqual([
      { kind: 'SALE', type: 'PROVIDER_CLEARING', ownerId: null, amount: '49.99' },
      { kind: 'SALE', type: 'INSTRUCTOR_PAYABLE', ownerId: instructor, amount: '-34.99' },
      { kind: 'SALE', type: 'PLATFORM_REVENUE', ownerId: null, amount: '-15.00' },
    ]);
    expect(await reconcileLedger(it_.db, { orderLineIds: [paidLine!.id, freeLine!.id] })).toEqual(
      [],
    );
  }, 30_000);

  it('a redelivered OrderPaid is a duplicate, and a re-emitted one (new event id) posts nothing new', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const o = await order([{ listAmount: '25.00' }, { listAmount: '19.99' }]);
    const ids = o.lines.map((l) => l.id);
    const first = orderPaid(o);

    await expect(processor.process(sale, first)).resolves.toBe('processed');
    await expect(processor.process(sale, first)).resolves.toBe('duplicate');
    // Same facts under another event id: the ledger's (kind, order_line_id, refund_id) unique.
    await expect(processor.process(sale, orderPaid(o))).resolves.toBe('processed');

    expect(await entryCount(ids)).toBe(2);
    expect((await legs(ids)).filter((l) => l.type === 'PROVIDER_CLEARING')).toHaveLength(2);
    expect(await reconcileLedger(it_.db, { orderLineIds: ids })).toEqual([]);
  }, 30_000);

  it('RefundSucceeded posts the exact mirror of the SALE; a redelivery posts nothing', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const o = await order([{ listAmount: '49.99' }, { listAmount: '19.99' }]);
    const [refunded, kept] = o.lines;
    await expect(processor.process(sale, orderPaid(o))).resolves.toBe('processed');
    const succeeded = await seedSucceededRefund(it_.db, o, refunded!);
    const event = track(
      commerceEnvelope(
        'RefundSucceeded',
        o.orderId,
        refundSucceededPayload(o, refunded!, succeeded),
      ),
    );

    await expect(processor.process(refund, event)).resolves.toBe('processed');
    await expect(processor.process(refund, event)).resolves.toBe('duplicate');

    const instructor = refunded!.instructorId;
    expect(await legs([refunded!.id])).toEqual([
      { kind: 'SALE', type: 'PROVIDER_CLEARING', ownerId: null, amount: '49.99' },
      { kind: 'SALE', type: 'INSTRUCTOR_PAYABLE', ownerId: instructor, amount: '-34.99' },
      { kind: 'SALE', type: 'PLATFORM_REVENUE', ownerId: null, amount: '-15.00' },
      { kind: 'REFUND', type: 'PROVIDER_CLEARING', ownerId: null, amount: '-49.99' },
      { kind: 'REFUND', type: 'INSTRUCTOR_PAYABLE', ownerId: instructor, amount: '34.99' },
      { kind: 'REFUND', type: 'PLATFORM_REVENUE', ownerId: null, amount: '15.00' },
    ]);
    expect(await entryCount([kept!.id])).toBe(1);
    expect(await reconcileLedger(it_.db, { orderLineIds: [refunded!.id, kept!.id] })).toEqual([]);
  }, 30_000);

  it('a REFUND before its SALE is retryable (nothing committed), then succeeds after the SALE', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const o = await order([{ listAmount: '29.99' }]);
    const line = o.lines[0]!;
    const succeeded = await seedSucceededRefund(it_.db, o, line);
    const refundEvent = track(
      commerceEnvelope('RefundSucceeded', o.orderId, refundSucceededPayload(o, line, succeeded)),
    );

    // Out of order: the dispatcher would retry this (not a NonRetryableError), then DLQ it.
    await expect(processor.process(refund, refundEvent)).rejects.toBeInstanceOf(
      LedgerSaleMissingError,
    );
    expect(await claimed(refund.consumerName, refundEvent.eventId)).toBe(false);
    expect(await entryCount([line.id])).toBe(0);
    // The reconciliation sees the gap meanwhile (ordered by line, then kind).
    expect(await reconcileLedger(it_.db, { orderLineIds: [line.id] })).toEqual([
      {
        kind: 'REFUND',
        orderLineId: line.id,
        refundId: succeeded.refundId,
        problem: 'missing or wrong',
      },
      { kind: 'SALE', orderLineId: line.id, refundId: null, problem: 'missing or wrong' },
    ]);

    await expect(processor.process(sale, orderPaid(o))).resolves.toBe('processed');
    await expect(processor.process(refund, refundEvent)).resolves.toBe('processed');

    expect(await entryCount([line.id])).toBe(2);
    expect(await reconcileLedger(it_.db, { orderLineIds: [line.id] })).toEqual([]);
  }, 30_000);

  it('LedgerReconciliationJob: clean over this file’s lines, and a missing SALE is reported', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const job = new LedgerReconciliationJob(
      it_.db,
      fakeConfig({ LEDGER_RECONCILIATION_SETTLE_MINUTES: 60 }),
      new SchedulerRegistry(),
    );
    // The default settle bound (now - 60 min) excludes everything this file just paid.
    const settled = await job.runOnce({ ...job.options(), orderLineIds: lineIds });
    expect(settled).toMatchObject({ status: 'completed', differences: [] });

    // Bound in the future: every fact of this file counts, and the ledger matches commerce.
    const future = new Date(Date.now() + 60_000);
    const clean = await job.runOnce({ settledBefore: future, orderLineIds: lineIds });
    expect(clean).toMatchObject({ status: 'completed', differences: [], unsettledRefunds: 0 });
    if (clean.status !== 'completed') throw new Error('unreachable');
    expect(clean.totals.ledgerSales).toBe(clean.totals.commerceSales);
    expect(clean.totals.ledgerRefunds).toBe(clean.totals.commerceRefunds);

    // A paid order whose OrderPaid never reached the writer.
    const lost = await order([{ listAmount: '9.99' }]);
    const report = await job.runOnce({ settledBefore: future, orderLineIds: lineIds });
    expect(report).toMatchObject({
      status: 'completed',
      differences: [
        {
          kind: 'SALE',
          orderLineId: lost.lines[0]!.id,
          refundId: null,
          problem: 'missing or wrong',
        },
      ],
    });
    await expect(processor.process(sale, orderPaid(lost))).resolves.toBe('processed');
    expect(await job.runOnce({ settledBefore: future, orderLineIds: lineIds })).toMatchObject({
      status: 'completed',
      differences: [],
    });
  }, 30_000);

  it('LedgerReconciliationJob does not report a refund that succeeded after the settle bound', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const job = new LedgerReconciliationJob(it_.db, fakeConfig({}), new SchedulerRegistry());
    const o = await order([{ listAmount: '14.99' }]);
    const line = o.lines[0]!;
    await expect(processor.process(sale, orderPaid(o))).resolves.toBe('processed');
    // The bound from the database clock: after the order was paid, before the refund succeeds.
    const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(it_.db);
    const bound = rows[0]!.now;
    // `Date` keeps milliseconds only (Postgres keeps microseconds): let the database clock move
    // past the bound so the refund's succeeded_at cannot truncate to the same millisecond.
    await sql`SELECT pg_sleep(0.005)`.execute(it_.db);
    const succeeded = await seedSucceededRefund(it_.db, o, line);
    expect(succeeded.succeededAt.getTime()).toBeGreaterThan(bound.getTime());

    // Its RefundSucceeded is "in flight": the REFUND entry is missing but not reported.
    expect(await job.runOnce({ settledBefore: bound, orderLineIds: [line.id] })).toMatchObject({
      status: 'completed',
      differences: [],
      unsettledRefunds: 1,
    });
    // Once the bound passes the refund, the missing entry is reported.
    const later = new Date(succeeded.succeededAt.getTime() + 1_000);
    expect(await job.runOnce({ settledBefore: later, orderLineIds: [line.id] })).toMatchObject({
      status: 'completed',
      differences: [
        {
          kind: 'REFUND',
          orderLineId: line.id,
          refundId: succeeded.refundId,
          problem: 'missing or wrong',
        },
      ],
      unsettledRefunds: 0,
    });
    const event = track(
      commerceEnvelope('RefundSucceeded', o.orderId, refundSucceededPayload(o, line, succeeded)),
    );
    await expect(processor.process(refund, event)).resolves.toBe('processed');
    expect(await job.runOnce({ settledBefore: later, orderLineIds: [line.id] })).toMatchObject({
      status: 'completed',
      differences: [],
    });
  }, 30_000);

  it('LedgerReconciliationJob stops when another replica holds the advisory lock', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const job = new LedgerReconciliationJob(it_.db, fakeConfig({}), new SchedulerRegistry());
    await it_.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${0x75646d79_05}::bigint)`.execute(trx);
      await expect(
        job.runOnce({ settledBefore: new Date(), orderLineIds: lineIds }),
      ).resolves.toEqual({ status: 'locked' });
    });
  }, 30_000);
});
