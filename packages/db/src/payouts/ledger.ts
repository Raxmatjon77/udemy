/**
 * Double-entry ledger (docs/phase-4-schema-design.md D13, §1.13, §6 items 1 and 5, §8.7), for
 * the worker's payouts.ledger-writer (T14). Written by the worker only (a convention: API and
 * worker share udemy_app).
 *
 * SALE per paid order line with final > 0: Dr PROVIDER_CLEARING +final, Cr
 * INSTRUCTOR_PAYABLE[instructor] -instructorShare, Cr PLATFORM_REVENUE -platformShare (zero legs
 * omitted). REFUND: the exact negation of the line's SALE postings (journal_entries_mirror_ck).
 * Idempotency is `(kind, order_line_id, refund_id)`, independent of the event id: the entry
 * insert is `ON CONFLICT DO NOTHING` with no target. Balance is checked at COMMIT
 * (postings_balanced_ck). Errors (§9): journal_entries_sale_missing_ck (23514) is RETRYABLE (the
 * SALE is still in flight); postings_balanced_ck / journal_entries_mirror_ck / postings_*_fk are
 * not. The caller ignores RefundSucceeded with orderWasPaid = false (§6 item 5).
 */
import { sql } from 'kysely';
import { assertCurrency, assertMoney, assertOneOf } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';

export type LedgerAccountType = 'PROVIDER_CLEARING' | 'PLATFORM_REVENUE' | 'INSTRUCTOR_PAYABLE';

/**
 * Lazily creates the account (`ON CONFLICT DO NOTHING`, no target) and returns its id. The
 * lookup uses `owner_id = $1` / `owner_id IS NULL` (IS NOT DISTINCT FROM is not indexable).
 */
export async function ensureLedgerAccount(
  executor: Executor,
  input: { type: LedgerAccountType; ownerId: string | null; currency: string },
): Promise<string> {
  assertOneOf('type', input.type, ['PROVIDER_CLEARING', 'PLATFORM_REVENUE', 'INSTRUCTOR_PAYABLE']);
  assertCurrency('currency', input.currency);
  if ((input.type === 'INSTRUCTOR_PAYABLE') !== (input.ownerId !== null)) {
    throw new RangeError('ownerId is required for INSTRUCTOR_PAYABLE and forbidden otherwise');
  }
  await sql`
    INSERT INTO payouts.accounts (type, owner_id, currency) VALUES (${input.type}, ${input.ownerId}, ${input.currency})
    ON CONFLICT DO NOTHING
  `.execute(executor);
  const owner = input.ownerId === null ? sql`owner_id IS NULL` : sql`owner_id = ${input.ownerId}`;
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM payouts.accounts WHERE type = ${input.type} AND ${owner} AND currency = ${input.currency}
  `.execute(executor);
  return rows[0]!.id;
}

export type PostOutcome = 'POSTED' | 'ALREADY_POSTED' | 'ZERO_AMOUNT' | 'LINE_ALREADY_REVERSED';

export interface PostResult {
  outcome: PostOutcome;
  /** The entry for (kind, line, refund): new or existing; null for ZERO_AMOUNT / LINE_ALREADY_REVERSED. */
  entryId: string | null;
}

export interface PostSaleInput {
  orderLineId: string;
  /** Outbox event id (trace only; one OrderPaid creates one entry per line). */
  sourceEventId: string;
  /** Business time: the order's paidAt. */
  occurredAt: Date;
  currency: string;
  instructorId: string;
  /** From the OrderPaid payload (= the line's generated columns), decimal strings. */
  finalAmount: string;
  instructorShareAmount: string;
  platformShareAmount: string;
}

export async function postSaleEntry(executor: Executor, input: PostSaleInput): Promise<PostResult> {
  const trx = requireTransaction(executor, 'postSaleEntry');
  assertMoney('finalAmount', input.finalAmount);
  assertMoney('instructorShareAmount', input.instructorShareAmount);
  assertMoney('platformShareAmount', input.platformShareAmount);
  assertCurrency('currency', input.currency);
  const { rows: zero } = await sql<{
    isZero: boolean;
  }>`SELECT ${input.finalAmount}::numeric = 0 AS is_zero`.execute(trx);
  if (zero[0]?.isZero === true) return { outcome: 'ZERO_AMOUNT', entryId: null };

  const { rows } = await sql<{ id: string }>`
    INSERT INTO payouts.journal_entries (kind, order_line_id, refund_id, source_event_id, currency, occurred_at)
    VALUES ('SALE', ${input.orderLineId}, NULL, ${input.sourceEventId}, ${input.currency}, ${input.occurredAt})
    ON CONFLICT DO NOTHING
    RETURNING id
  `.execute(trx);
  const entryId = rows[0]?.id;
  if (entryId === undefined) {
    const { rows: existing } = await sql<{ id: string }>`
      SELECT id FROM payouts.journal_entries WHERE kind = 'SALE' AND order_line_id = ${input.orderLineId} AND refund_id IS NULL
    `.execute(trx);
    return { outcome: 'ALREADY_POSTED', entryId: existing[0]?.id ?? null };
  }
  const clearing = await ensureLedgerAccount(trx, {
    type: 'PROVIDER_CLEARING',
    ownerId: null,
    currency: input.currency,
  });
  const payable = await ensureLedgerAccount(trx, {
    type: 'INSTRUCTOR_PAYABLE',
    ownerId: input.instructorId,
    currency: input.currency,
  });
  const revenue = await ensureLedgerAccount(trx, {
    type: 'PLATFORM_REVENUE',
    ownerId: null,
    currency: input.currency,
  });
  await sql`
    INSERT INTO payouts.postings (entry_id, line_no, account_id, currency, amount)
    SELECT ${entryId}, row_number() OVER (ORDER BY v.ord), v.account_id, ${input.currency}, v.amount
      FROM (VALUES (1, ${clearing}::uuid,  ${input.finalAmount}::numeric),
                   (2, ${payable}::uuid,  -${input.instructorShareAmount}::numeric),
                   (3, ${revenue}::uuid,  -${input.platformShareAmount}::numeric)) v(ord, account_id, amount)
     WHERE v.amount <> 0
  `.execute(trx);
  return { outcome: 'POSTED', entryId };
}

export interface PostRefundInput {
  orderLineId: string;
  refundId: string;
  sourceEventId: string;
  /** Business time: the refund's succeededAt. */
  occurredAt: Date;
}

/**
 * The exact mirror of the line's SALE (currency taken from it). Throws 23514
 * journal_entries_sale_missing_ck while the SALE is not posted yet (retryable).
 * LINE_ALREADY_REVERSED = another refund already reversed this line (commerce allows one
 * SUCCEEDED refund per line, so this is an anomaly: alert, don't retry).
 */
export async function postRefundEntry(
  executor: Executor,
  input: PostRefundInput,
): Promise<PostResult> {
  const trx = requireTransaction(executor, 'postRefundEntry');
  const { rows } = await sql<{ id: string }>`
    INSERT INTO payouts.journal_entries (kind, order_line_id, refund_id, source_event_id, currency, occurred_at)
    VALUES ('REFUND', ${input.orderLineId}, ${input.refundId}, ${input.sourceEventId},
            (SELECT currency FROM payouts.journal_entries
              WHERE kind = 'SALE' AND order_line_id = ${input.orderLineId} AND refund_id IS NULL),
            ${input.occurredAt})
    ON CONFLICT DO NOTHING
    RETURNING id
  `.execute(trx);
  const entryId = rows[0]?.id;
  if (entryId === undefined) {
    const { rows: existing } = await sql<{ id: string }>`
      SELECT id FROM payouts.journal_entries
       WHERE kind = 'REFUND' AND order_line_id = ${input.orderLineId} AND refund_id = ${input.refundId}
    `.execute(trx);
    const id = existing[0]?.id;
    return id === undefined
      ? { outcome: 'LINE_ALREADY_REVERSED', entryId: null }
      : { outcome: 'ALREADY_POSTED', entryId: id };
  }
  await sql`
    INSERT INTO payouts.postings (entry_id, line_no, account_id, currency, amount)
    SELECT ${entryId}, p.line_no, p.account_id, p.currency, -p.amount
      FROM payouts.postings p
      JOIN payouts.journal_entries s ON s.id = p.entry_id
     WHERE s.kind = 'SALE' AND s.order_line_id = ${input.orderLineId} AND s.refund_id IS NULL
  `.execute(trx);
  return { outcome: 'POSTED', entryId };
}

export interface LedgerScope {
  /** Only these order lines (tests on a shared database). */
  orderLineIds?: readonly string[];
  /** Ops: only commerce facts of orders paid before this (let the worker drain, e.g. now - 1 h). */
  paidBefore?: Date;
}

export interface LedgerDifference {
  kind: 'SALE' | 'REFUND';
  orderLineId: string;
  refundId: string | null;
  problem: 'missing or wrong' | 'entry without a commerce fact';
}

function lineScope(column: string, scope: LedgerScope) {
  return scope.orderLineIds === undefined
    ? sql``
    : sql`AND ${sql.ref(column)} = ANY(${[...scope.orderLineIds]}::uuid[])`;
}

function paidScope(scope: LedgerScope) {
  return scope.paidBefore === undefined ? sql`` : sql`AND o.paid_at < ${scope.paidBefore}`;
}

/** paidBefore for ledger-side sums: entries of lines whose order was paid before the bound. */
function entryPaidScope(scope: LedgerScope) {
  return scope.paidBefore === undefined
    ? sql``
    : sql`AND e.order_line_id IN (SELECT l.id FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
                                   WHERE o.paid_at < ${scope.paidBefore})`;
}

/** §8.7 query 1: differences per fact; empty = the ledger equals commerce (for the scope). */
export async function reconcileLedger(
  executor: Executor,
  scope: LedgerScope = {},
): Promise<LedgerDifference[]> {
  const { rows } = await sql<LedgerDifference>`
    WITH paid_lines AS (
      SELECT l.id AS order_line_id, l.instructor_id, l.final_amount, l.instructor_share_amount, l.platform_share_amount
        FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
       WHERE o.paid_at IS NOT NULL AND l.final_amount > 0 ${lineScope('l.id', scope)} ${paidScope(scope)}),
    succ_refunds AS (
      SELECT r.id AS refund_id, r.order_line_id
        FROM commerce.refunds r JOIN commerce.orders o ON o.id = r.order_id
       WHERE r.status = 'SUCCEEDED' AND o.paid_at IS NOT NULL ${lineScope('r.order_line_id', scope)} ${paidScope(scope)}),
    legs AS (
      SELECT e.kind, e.order_line_id, e.refund_id,
             coalesce(sum(p.amount) FILTER (WHERE a.type = 'PROVIDER_CLEARING'), 0)  AS clearing,
             coalesce(sum(p.amount) FILTER (WHERE a.type = 'INSTRUCTOR_PAYABLE'), 0) AS payable,
             coalesce(sum(p.amount) FILTER (WHERE a.type = 'PLATFORM_REVENUE'), 0)   AS revenue,
             min(a.owner_id::text) FILTER (WHERE a.type = 'INSTRUCTOR_PAYABLE')      AS payee
        FROM payouts.journal_entries e
        JOIN payouts.postings p ON p.entry_id = e.id
        JOIN payouts.accounts a ON a.id = p.account_id
       WHERE true ${lineScope('e.order_line_id', scope)}
       GROUP BY e.kind, e.order_line_id, e.refund_id)
    SELECT 'SALE' AS kind, pl.order_line_id, NULL::uuid AS refund_id, 'missing or wrong' AS problem
      FROM paid_lines pl
      LEFT JOIN legs g ON g.kind = 'SALE' AND g.order_line_id = pl.order_line_id
     WHERE g.order_line_id IS NULL
        OR g.clearing <> pl.final_amount OR g.payable <> -pl.instructor_share_amount OR g.revenue <> -pl.platform_share_amount
        OR (pl.instructor_share_amount > 0 AND g.payee IS DISTINCT FROM pl.instructor_id::text)
    UNION ALL
    SELECT 'REFUND', sr.order_line_id, sr.refund_id, 'missing or wrong'
      FROM succ_refunds sr
      JOIN paid_lines pl ON pl.order_line_id = sr.order_line_id
      LEFT JOIN legs g ON g.kind = 'REFUND' AND g.refund_id = sr.refund_id
     WHERE g.refund_id IS NULL
        OR g.clearing <> -pl.final_amount OR g.payable <> pl.instructor_share_amount OR g.revenue <> pl.platform_share_amount
    UNION ALL
    -- checked against all of commerce (not the paidBefore-scoped CTEs), so recent facts are not "missing"
    SELECT g.kind, g.order_line_id, g.refund_id, 'entry without a commerce fact'
      FROM legs g
     WHERE (g.kind = 'SALE' AND NOT EXISTS (
              SELECT 1 FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
               WHERE l.id = g.order_line_id AND o.paid_at IS NOT NULL AND l.final_amount > 0))
        OR (g.kind = 'REFUND' AND NOT EXISTS (
              SELECT 1 FROM commerce.refunds r JOIN commerce.orders o ON o.id = r.order_id
               WHERE r.id = g.refund_id AND r.status = 'SUCCEEDED' AND o.paid_at IS NOT NULL))
     ORDER BY 2, 1, 3
  `.execute(executor);
  return rows;
}

export interface LedgerTotals {
  ledgerSales: string;
  commerceSales: string;
  ledgerRefunds: string;
  commerceRefunds: string;
}

/** §8.7 query 2 (the D13 statement): ledger SALE clearing = paid finals; REFUND clearing = -SUCCEEDED refunds. */
export async function getLedgerTotals(
  executor: Executor,
  scope: LedgerScope = {},
): Promise<LedgerTotals> {
  const { rows } = await sql<LedgerTotals>`
    SELECT
      (SELECT coalesce(sum(p.amount), 0) FROM payouts.postings p JOIN payouts.journal_entries e ON e.id = p.entry_id
         JOIN payouts.accounts a ON a.id = p.account_id
        WHERE e.kind = 'SALE' AND a.type = 'PROVIDER_CLEARING' ${lineScope('e.order_line_id', scope)} ${entryPaidScope(scope)})   AS ledger_sales,
      (SELECT coalesce(sum(l.final_amount), 0) FROM commerce.order_lines l JOIN commerce.orders o ON o.id = l.order_id
        WHERE o.paid_at IS NOT NULL ${lineScope('l.id', scope)} ${paidScope(scope)})                      AS commerce_sales,
      (SELECT coalesce(-sum(p.amount), 0) FROM payouts.postings p JOIN payouts.journal_entries e ON e.id = p.entry_id
         JOIN payouts.accounts a ON a.id = p.account_id
        WHERE e.kind = 'REFUND' AND a.type = 'PROVIDER_CLEARING' ${lineScope('e.order_line_id', scope)} ${entryPaidScope(scope)}) AS ledger_refunds,
      (SELECT coalesce(sum(r.amount), 0) FROM commerce.refunds r JOIN commerce.orders o ON o.id = r.order_id
        WHERE r.status = 'SUCCEEDED' AND o.paid_at IS NOT NULL ${lineScope('r.order_line_id', scope)} ${paidScope(scope)}) AS commerce_refunds
  `.execute(executor);
  return rows[0]!;
}
