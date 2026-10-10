import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  type DB,
  getLedgerTotals,
  type LedgerDifference,
  type LedgerTotals,
  reconcileLedger,
  sql,
  type Transaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { WorkerConfigService } from '../shared/config';
import { ADVISORY_LOCK_KEYS } from './advisory-lock-keys';

/** Advisory-lock key of the ledger reconciliation (`udmy` + 0x05; all keys: advisory-lock-keys.ts). */
export const LEDGER_RECONCILIATION_LOCK_KEY = ADVISORY_LOCK_KEYS.ledgerReconciliation;

const INTERVAL_NAME = 'ledger-reconciliation';
const FIRST_RUN_NAME = 'ledger-reconciliation.first-run';
/** Differences included in the log line (the count is always complete). */
const MAX_LOGGED_DIFFERENCES = 50;

export interface LedgerReconciliationOptions {
  /** Commerce facts at or after this instant are still settling and not reconciled. */
  readonly settledBefore: Date;
  /** Only these order lines (integration tests on a shared database). */
  readonly orderLineIds?: readonly string[];
}

export type LedgerReconciliationResult =
  | { readonly status: 'locked' }
  | {
      readonly status: 'completed';
      readonly differences: readonly LedgerDifference[];
      /** REFUND facts that succeeded after `settledBefore` (their event may be in flight). */
      readonly unsettledRefunds: number;
      readonly totals: LedgerTotals;
    };

/**
 * Periodic check that the payouts ledger equals commerce (Phase 4 design D13, schema doc
 * §8.7): `reconcileLedger` (differences per fact) plus `getLedgerTotals` (the D13 statement),
 * every LEDGER_RECONCILIATION_INTERVAL_MS. Read only: it never repairs anything. Any
 * difference is logged at ERROR level ("LEDGER MISMATCH") for alerting; the fix is a DLQ replay
 * of the ledger writer or a manual investigation.
 *
 * Only facts older than LEDGER_RECONCILIATION_SETTLE_MINUTES are compared, so events still
 * travelling through Debezium and Kafka are not reported: orders paid before the bound, and
 * REFUND differences whose refund succeeded after it are dropped.
 *
 * One REPEATABLE READ, read-only transaction per run (one consistent snapshot for both
 * queries), guarded by `pg_try_advisory_xact_lock(LEDGER_RECONCILIATION_LOCK_KEY)`: when another
 * replica holds it, this run stops. Runs never overlap within a replica; shutdown waits.
 */
@Injectable()
export class LedgerReconciliationJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(LedgerReconciliationJob.name);
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly config: WorkerConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('LEDGER_RECONCILIATION_ENABLED')) {
      this.logger.log('Ledger reconciliation disabled (LEDGER_RECONCILIATION_ENABLED=false)');
      return;
    }
    const intervalMs = this.config.get('LEDGER_RECONCILIATION_INTERVAL_MS');
    // Registered timers are cleared by @nestjs/schedule on application shutdown.
    const first = setTimeout(() => {
      this.scheduler.deleteTimeout(FIRST_RUN_NAME);
      this.trigger();
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => this.trigger(), intervalMs),
      );
    }, this.config.get('LEDGER_RECONCILIATION_INITIAL_DELAY_MS'));
    this.scheduler.addTimeout(FIRST_RUN_NAME, first);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  /** The options of a scheduled run, from the validated env. */
  options(now: Date = new Date()): LedgerReconciliationOptions {
    const settleMs = this.config.get('LEDGER_RECONCILIATION_SETTLE_MINUTES') * 60_000;
    return { settledBefore: new Date(now.getTime() - settleMs) };
  }

  /** Starts a run unless one is still in progress in this replica. */
  private trigger(): void {
    if (this.stopping) return;
    if (this.running !== undefined) {
      this.logger.warn('Previous ledger reconciliation still running; skipping this tick');
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Ledger reconciliation failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One complete run. Public for tests and manual runs. */
  async runOnce(
    options: LedgerReconciliationOptions = this.options(),
  ): Promise<LedgerReconciliationResult> {
    const result = await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((trx) => this.reconcile(trx, options));
    const bound = { settledBefore: options.settledBefore.toISOString() };
    if (result.status === 'locked') {
      this.logger.log(bound, 'Ledger reconciliation is running in another replica; stopping');
    } else if (result.differences.length > 0) {
      this.logger.error(
        {
          ...bound,
          differenceCount: result.differences.length,
          differences: result.differences.slice(0, MAX_LOGGED_DIFFERENCES),
          unsettledRefunds: result.unsettledRefunds,
          totals: result.totals,
        },
        `LEDGER MISMATCH: ${result.differences.length} commerce fact(s) differ from the payouts ledger`,
      );
    } else {
      this.logger.log(
        { ...bound, unsettledRefunds: result.unsettledRefunds, totals: result.totals },
        'Ledger reconciliation clean',
      );
    }
    return result;
  }

  private async reconcile(
    trx: Transaction<DB>,
    options: LedgerReconciliationOptions,
  ): Promise<LedgerReconciliationResult> {
    const { rows } = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_xact_lock(${LEDGER_RECONCILIATION_LOCK_KEY}::bigint) AS locked`.execute(
      trx,
    );
    if (rows[0]?.locked !== true) return { status: 'locked' };

    const scope = {
      paidBefore: options.settledBefore,
      ...(options.orderLineIds === undefined ? {} : { orderLineIds: options.orderLineIds }),
    };
    const all = await reconcileLedger(trx, scope);
    const unsettled = await this.unsettledRefundIds(trx, all, options.settledBefore);
    const differences = all.filter((d) => d.refundId === null || !unsettled.has(d.refundId));
    const totals = await getLedgerTotals(trx, scope);
    return { status: 'completed', differences, unsettledRefunds: unsettled.size, totals };
  }

  /** Refunds among the REFUND differences that succeeded at or after the bound. */
  private async unsettledRefundIds(
    trx: Transaction<DB>,
    differences: readonly LedgerDifference[],
    settledBefore: Date,
  ): Promise<Set<string>> {
    const ids = differences.flatMap((d) =>
      d.kind === 'REFUND' && d.problem === 'missing or wrong' && d.refundId !== null
        ? [d.refundId]
        : [],
    );
    if (ids.length === 0) return new Set();
    const recent = await trx
      .selectFrom('commerce.refunds')
      .select('id')
      .where('id', 'in', ids)
      .where('succeededAt', '>=', settledBefore)
      .execute();
    return new Set(recent.map((r) => r.id));
  }
}
