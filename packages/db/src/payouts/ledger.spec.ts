import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import {
  ensureLedgerAccount,
  getLedgerTotals,
  postRefundEntry,
  postSaleEntry,
  reconcileLedger,
} from './ledger';

const SALE = {
  orderLineId: 'l1',
  sourceEventId: 'ev',
  occurredAt: new Date('2026-10-10T00:00:00Z'),
  currency: 'USD',
  instructorId: 'i1',
  finalAmount: '19.99',
  instructorShareAmount: '13.99',
  platformShareAmount: '6.00',
};

describe('ensureLedgerAccount', () => {
  it('ON CONFLICT DO NOTHING without target, then an indexable owner lookup', async () => {
    const s = scriptedDb([{}, { rows: [{ id: 'a' }] }, {}, { rows: [{ id: 'b' }] }]);
    expect(
      await ensureLedgerAccount(s.db, {
        type: 'PROVIDER_CLEARING',
        ownerId: null,
        currency: 'USD',
      }),
    ).toBe('a');
    expect(
      await ensureLedgerAccount(s.db, {
        type: 'INSTRUCTOR_PAYABLE',
        ownerId: 'i1',
        currency: 'USD',
      }),
    ).toBe('b');
    expect(s.statements[0]).toMatch(/ON CONFLICT DO NOTHING$/);
    expect(s.statements[1]).toContain('owner_id IS NULL');
    expect(s.statements[3]).toContain('owner_id = $2');
    expect(s.statements.join(' ')).not.toContain('IS NOT DISTINCT FROM');
    await expect(
      ensureLedgerAccount(s.db, { type: 'INSTRUCTOR_PAYABLE', ownerId: null, currency: 'USD' }),
    ).rejects.toThrow(RangeError);
    await expect(
      ensureLedgerAccount(s.db, { type: 'PLATFORM_REVENUE', ownerId: null, currency: 'usd' }),
    ).rejects.toThrow(RangeError);
  });
});

describe('postSaleEntry', () => {
  it('ZERO_AMOUNT writes nothing', async () => {
    const s = scriptedDb([{ rows: [{ is_zero: true }] }]);
    const r = await s.db
      .transaction()
      .execute((trx) => postSaleEntry(trx, { ...SALE, finalAmount: '0.00' }));
    expect(r).toEqual({ outcome: 'ZERO_AMOUNT', entryId: null });
    expect(s.statements).toHaveLength(3);
  });

  it('ALREADY_POSTED when the idempotency unique swallowed the insert', async () => {
    const s = scriptedDb([{ rows: [{ is_zero: false }] }, { rows: [] }, { rows: [{ id: 'e0' }] }]);
    const r = await s.db.transaction().execute((trx) => postSaleEntry(trx, SALE));
    expect(r).toEqual({ outcome: 'ALREADY_POSTED', entryId: 'e0' });
    expect(s.statements[2]).toMatch(/ON CONFLICT DO NOTHING RETURNING id$/);
    expect(s.statements.some((q) => q.includes('payouts.postings'))).toBe(false);
  });

  it('POSTED: three accounts, zero legs filtered in SQL, signed amounts', async () => {
    const s = scriptedDb([
      { rows: [{ is_zero: false }] },
      { rows: [{ id: 'e1' }] },
      {},
      { rows: [{ id: 'clr' }] },
      {},
      { rows: [{ id: 'pay' }] },
      {},
      { rows: [{ id: 'rev' }] },
      {},
    ]);
    expect(await s.db.transaction().execute((trx) => postSaleEntry(trx, SALE))).toEqual({
      outcome: 'POSTED',
      entryId: 'e1',
    });
    const postings = s.statements.at(-2)!;
    expect(postings).toContain('WHERE v.amount <> 0');
    expect(postings).toContain('-$');
    expect(s.parameters.at(-2)).toEqual([
      'e1',
      'USD',
      'clr',
      '19.99',
      'pay',
      '13.99',
      'rev',
      '6.00',
    ]);
  });

  it('rejects non-decimal money before SQL', async () => {
    const s = scriptedDb();
    await s.db.transaction().execute(async (trx) => {
      await expect(postSaleEntry(trx, { ...SALE, finalAmount: '1e3' })).rejects.toThrow(RangeError);
      await expect(postSaleEntry(trx, { ...SALE, platformShareAmount: '-1.00' })).rejects.toThrow(
        RangeError,
      );
    });
    expect(s.statements).toEqual(['BEGIN', 'COMMIT']);
  });
});

describe('postRefundEntry', () => {
  const input = { orderLineId: 'l1', refundId: 'r1', sourceEventId: 'ev', occurredAt: new Date() };

  it('POSTED copies the negated SALE postings', async () => {
    const s = scriptedDb([{ rows: [{ id: 'e2' }] }, {}]);
    expect(await s.db.transaction().execute((trx) => postRefundEntry(trx, input))).toEqual({
      outcome: 'POSTED',
      entryId: 'e2',
    });
    expect(s.statements[1]).toContain(
      "(SELECT currency FROM payouts.journal_entries WHERE kind = 'SALE'",
    );
    expect(s.statements[2]).toContain('-p.amount');
  });

  it('ALREADY_POSTED vs LINE_ALREADY_REVERSED', async () => {
    const s = scriptedDb([{ rows: [] }, { rows: [{ id: 'e2' }] }, { rows: [] }, { rows: [] }]);
    await s.db.transaction().execute(async (trx) => {
      expect(await postRefundEntry(trx, input)).toEqual({
        outcome: 'ALREADY_POSTED',
        entryId: 'e2',
      });
      expect(await postRefundEntry(trx, input)).toEqual({
        outcome: 'LINE_ALREADY_REVERSED',
        entryId: null,
      });
    });
  });
});

describe('reconciliation', () => {
  it('unscoped = §8.7 verbatim; scopes add line / paidBefore filters', async () => {
    const s = scriptedDb([{ rows: [] }, { rows: [] }, { rows: [{ ledger_sales: '1' }] }]);
    await reconcileLedger(s.db);
    expect(s.statements[0]).not.toContain('ANY(');
    expect(s.statements[0]).not.toContain('o.paid_at <');
    await reconcileLedger(s.db, { orderLineIds: ['l1'], paidBefore: new Date() });
    expect(s.statements[1]).toContain('"l"."id" = ANY(');
    expect(s.statements[1]).toContain('AND o.paid_at < $');
    expect(await getLedgerTotals(s.db)).toEqual({ ledgerSales: '1' });
  });
});
