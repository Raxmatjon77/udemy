import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { DB } from '../generated/db';
import { createUser } from '../testing/fixtures';
import { createOrder, createRefund, payOrder } from '../testing/commerce-fixtures';
import {
  checkDeferredNow,
  deleteTestData,
  expectFailure,
  type PgErrorShape,
  rollback,
  useIntegrationDb,
} from '../testing/it-db.mjs';
import { MAX_BATCH_SIZE } from '../internal/assert';
import { completeRefundDispatch, leaseRefundsForDispatch } from '../commerce/refunds';
import type { PaidOrderLine } from '../commerce/orders';
import {
  ensureLedgerAccount,
  getLedgerTotals,
  postRefundEntry,
  postSaleEntry,
  reconcileLedger,
} from './ledger';

/**
 * payouts ledger (docs/phase-4-schema-design.md D13, §1.13, §8.7). Rolled back, except the one
 * "at COMMIT" balance test, which fails at COMMIT (cleanup in afterAll if it ever didn't).
 */
const pg = useIntegrationDb({ max: 2 });
const committedUsers: string[] = [];
type Trx = Transaction<DB>;

afterAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  await deleteTestData(pg.db, committedUsers);
});

async function paidLines(trx: Trx, amounts: string[]) {
  const buyer = await createUser(trx);
  const instructor = await createUser(trx);
  const order = await createOrder(trx, {
    userId: buyer,
    lines: amounts.map((listAmount) => ({ instructorId: instructor, listAmount })),
  });
  const paid = await payOrder(trx, order);
  if (paid.outcome !== 'APPLIED') throw new Error(`unexpected ${paid.outcome}`);
  return { order, buyer, instructor, lines: paid.lines, paidAt: paid.paidAt };
}

function sale(line: PaidOrderLine, sourceEventId: string, occurredAt: Date) {
  return {
    orderLineId: line.id,
    sourceEventId,
    occurredAt,
    currency: 'USD',
    instructorId: line.instructorId,
    finalAmount: line.finalAmount,
    instructorShareAmount: line.instructorShareAmount,
    platformShareAmount: line.platformShareAmount,
  };
}

async function succeededRefund(
  trx: Trx,
  order: { orderId: string; userId: string },
  line: PaidOrderLine,
): Promise<string> {
  const id = await createRefund(trx, {
    orderId: order.orderId,
    orderLineId: line.id,
    userId: order.userId,
    amount: line.finalAmount,
  });
  const leased = (await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })).refunds.find(
    (r) => r.id === id,
  )!;
  await completeRefundDispatch(trx, {
    ...leased,
    refundId: id,
    status: 'SUCCEEDED',
    providerRefundId: `re_${id}`,
  });
  return id;
}

describe('ledger writer', () => {
  it('multi-line SALE with one source event, idempotent replay, mirror REFUND; reconciliation is empty', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const paid = await paidLines(trx, ['25.00', '19.99']);
      const { order, paidAt } = paid;
      // refund the 25.00 line (markOrderPaid returns lines in course_id order)
      const lines = [...paid.lines].sort((a, b) => b.finalAmount.localeCompare(a.finalAmount));
      const evt = randomUUID();
      for (const l of lines)
        expect((await postSaleEntry(trx, sale(l, evt, paidAt))).outcome).toBe('POSTED');
      for (const l of lines)
        expect((await postSaleEntry(trx, sale(l, randomUUID(), paidAt))).outcome).toBe(
          'ALREADY_POSTED',
        );
      await checkDeferredNow(trx);
      const scope = { orderLineIds: lines.map((l) => l.id) };
      expect(await reconcileLedger(trx, scope)).toEqual([]);

      const refundId = await succeededRefund(trx, order, lines[0]!);
      expect(await reconcileLedger(trx, scope)).toEqual([
        { kind: 'REFUND', orderLineId: lines[0]!.id, refundId, problem: 'missing or wrong' },
      ]);
      const posted = await postRefundEntry(trx, {
        orderLineId: lines[0]!.id,
        refundId,
        sourceEventId: randomUUID(),
        occurredAt: new Date(),
      });
      expect(posted.outcome).toBe('POSTED');
      expect(
        (
          await postRefundEntry(trx, {
            orderLineId: lines[0]!.id,
            refundId,
            sourceEventId: randomUUID(),
            occurredAt: new Date(),
          })
        ).outcome,
      ).toBe('ALREADY_POSTED');
      // a different refund id for an already reversed line
      expect(
        (
          await postRefundEntry(trx, {
            orderLineId: lines[0]!.id,
            refundId: randomUUID(),
            sourceEventId: randomUUID(),
            occurredAt: new Date(),
          })
        ).outcome,
      ).toBe('LINE_ALREADY_REVERSED');
      await checkDeferredNow(trx);
      expect(await reconcileLedger(trx, scope)).toEqual([]);
      expect(await getLedgerTotals(trx, scope)).toEqual({
        ledgerSales: '44.99',
        commerceSales: '44.99',
        ledgerRefunds: '25.00',
        commerceRefunds: '25.00',
      });
      const bal = await sql<{ type: string; balance: string }>`
        SELECT b.type, sum(p.amount)::text AS balance
          FROM payouts.postings p JOIN payouts.account_balances b ON b.account_id = p.account_id
         WHERE p.entry_id IN (SELECT id FROM payouts.journal_entries WHERE order_line_id = ANY(${scope.orderLineIds}::uuid[]))
         GROUP BY b.type ORDER BY b.type
      `.execute(trx);
      // remaining line 19.99: instructor 13.99, platform 6.00
      expect(bal.rows).toEqual([
        { type: 'INSTRUCTOR_PAYABLE', balance: '-13.99' },
        { type: 'PLATFORM_REVENUE', balance: '-6.00' },
        { type: 'PROVIDER_CLEARING', balance: '19.99' },
      ]);
    });
  });

  it('zero-final lines get no entry; a REFUND before its SALE raises the retryable journal_entries_sale_missing_ck', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { lines, paidAt } = await paidLines(trx, ['25.00']);
      const l = lines[0]!;
      expect(
        await postSaleEntry(trx, { ...sale(l, randomUUID(), paidAt), finalAmount: '0.00' }),
      ).toEqual({
        outcome: 'ZERO_AMOUNT',
        entryId: null,
      });
      const err = await expectFailure(trx, () =>
        postRefundEntry(trx, {
          orderLineId: l.id,
          refundId: randomUUID(),
          sourceEventId: randomUUID(),
          occurredAt: new Date(),
        }),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'journal_entries_sale_missing_ck' });
      expect(await reconcileLedger(trx, { orderLineIds: [l.id] })).toEqual([
        { kind: 'SALE', orderLineId: l.id, refundId: null, problem: 'missing or wrong' },
      ]);
    });
  });

  it('an unbalanced entry fails postings_balanced_ck at a real COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await pg.db
      .transaction()
      .execute(async (trx) => {
        const { buyer, instructor, lines, paidAt } = await paidLines(trx, ['25.00']);
        committedUsers.push(buyer, instructor);
        await postSaleEntry(trx, {
          ...sale(lines[0]!, randomUUID(), paidAt),
          platformShareAmount: '7.49',
        }); // 25 != 17.50 + 7.49
      })
      .then(
        () => {
          throw new Error('expected the COMMIT to fail');
        },
        (e: unknown) => e as PgErrorShape,
      );
    expect(err).toMatchObject({ code: '23514', constraint: 'postings_balanced_ck' });
  });

  it('currency pins, a non-mirror REFUND and a second REFUND for a line are rejected', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { order, lines, paidAt } = await paidLines(trx, ['25.00']);
      const l = lines[0]!;
      const sold = await postSaleEntry(trx, sale(l, randomUUID(), paidAt));
      const eur = await ensureLedgerAccount(trx, {
        type: 'PLATFORM_REVENUE',
        ownerId: null,
        currency: 'EUR',
      });
      const fk = await expectFailure(trx, () =>
        sql`INSERT INTO payouts.postings (entry_id, line_no, account_id, currency, amount) VALUES (${sold.entryId}, 9, ${eur}, 'USD', 1)`.execute(
          trx,
        ),
      );
      expect(fk).toMatchObject({ code: '23503', constraint: 'postings_account_id_currency_fk' });
      const fk2 = await expectFailure(trx, () =>
        sql`INSERT INTO payouts.postings (entry_id, line_no, account_id, currency, amount) VALUES (${sold.entryId}, 9, ${eur}, 'EUR', 1)`.execute(
          trx,
        ),
      );
      expect(fk2).toMatchObject({ code: '23503', constraint: 'postings_entry_id_currency_fk' });
      await checkDeferredNow(trx);

      const refundId = await succeededRefund(trx, order, l);
      // hand-written refund entry with a balanced but non-mirror split
      const err = await expectFailure(trx, async () => {
        const { rows } = await sql<{ id: string }>`
          INSERT INTO payouts.journal_entries (kind, order_line_id, refund_id, source_event_id, currency, occurred_at)
          VALUES ('REFUND', ${l.id}, ${refundId}, ${randomUUID()}, 'USD', now()) RETURNING id
        `.execute(trx);
        await sql`
          INSERT INTO payouts.postings (entry_id, line_no, account_id, currency, amount)
          SELECT ${rows[0]!.id}, p.line_no, p.account_id, p.currency,
                 CASE p.line_no WHEN 2 THEN -p.amount - 1 WHEN 3 THEN -p.amount + 1 ELSE -p.amount END
            FROM payouts.postings p WHERE p.entry_id = ${sold.entryId}
        `.execute(trx);
        await checkDeferredNow(trx);
      });
      expect(err).toMatchObject({ code: '23514', constraint: 'journal_entries_mirror_ck' });

      await postRefundEntry(trx, {
        orderLineId: l.id,
        refundId,
        sourceEventId: randomUUID(),
        occurredAt: new Date(),
      });
      const dup = await expectFailure(trx, () =>
        sql`
          INSERT INTO payouts.journal_entries (kind, order_line_id, refund_id, source_event_id, currency, occurred_at)
          VALUES ('REFUND', ${l.id}, ${randomUUID()}, ${randomUUID()}, 'USD', now())
        `.execute(trx),
      );
      expect(dup).toMatchObject({
        code: '23505',
        constraint: 'journal_entries_order_line_id_refund_uq',
      });
      await checkDeferredNow(trx);
    });
  });
});
