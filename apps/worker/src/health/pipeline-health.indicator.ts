import { Injectable, Logger } from '@nestjs/common';
import {
  type Database,
  type HealthIndicatorResult,
  InjectDatabase,
  indicatorResult,
} from '@udemy/nest-common';
import { readReplicationSlot, type ReplicationSlotState } from '../maintenance/replication-slot';
import { ConsumerLagReporter } from '../messaging/kafka/consumer-lag.reporter';
import { WorkerConfigService } from '../shared/config';
import { checkConnector, type ConnectorCheck } from './connector-status';

/** Bound on each pipeline probe (Connect REST call, slot query). */
export const PIPELINE_PROBE_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type SlotCheck =
  | { readonly ok: true; readonly slot: ReplicationSlotState }
  | { readonly ok: false; readonly slot?: ReplicationSlotState; readonly message: string };

/**
 * The readiness "pipeline" detail: outbox -> Debezium -> Kafka health as seen from the worker.
 *
 * - `connector`: connector + task states from Kafka Connect REST (KAFKA_CONNECT_URL; skipped when
 *   unset, e.g. in environments where the worker can't reach Connect).
 * - `replicationSlot`: `pg_replication_slots` row of OUTBOX_REPLICATION_SLOT with the lag in
 *   bytes (`pg_current_wal_lsn() - confirmed_flush_lsn`; includes unrelated WAL, so an idle
 *   pipeline still shows some lag: watch the trend, not the absolute value).
 * - `consumerLag`: the latest ConsumerLagReporter sample (total and per topic).
 *
 * NON-FATAL by design: a FAILED/UNASSIGNED connector task, a missing or inactive slot, or an
 * unreachable Connect make this detail `degraded` (HTTP 200, overall status `degraded`, with a
 * message saying what to do), never `down` (503). Reasons:
 * - The worker serves no traffic; readiness only gates rollouts and Service endpoints. A 503
 *   would block worker deploys (including the one carrying a fix) without helping Debezium,
 *   which runs in Kafka Connect, not in this pod.
 * - The worker is still useful while Debezium is broken: it drains what is already in Kafka.
 * - Debezium's health is shared by all replicas; failing every replica at once on an external
 *   dependency is the classic cascading-readiness mistake. Alert on the degraded detail and the
 *   logs instead (Kafka Connect metrics in prod).
 */
@Injectable()
export class PipelineHealthIndicator {
  private readonly logger = new Logger(PipelineHealthIndicator.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly config: WorkerConfigService,
    private readonly lag: ConsumerLagReporter,
  ) {}

  async check<TKey extends string>(key: TKey): Promise<HealthIndicatorResult<TKey>> {
    const [connector, slot] = await Promise.all([this.checkConnector(), this.checkSlot()]);
    const problems: string[] = [];
    if (connector !== undefined && !connector.ok) problems.push(connector.message);
    if (!slot.ok) problems.push(slot.message);

    const lag = this.lag.lastSnapshot();
    const details: Record<string, unknown> = {
      connector: connector ?? { skipped: 'KAFKA_CONNECT_URL is not set' },
      replicationSlot:
        slot.slot === undefined
          ? { name: this.config.get('OUTBOX_REPLICATION_SLOT'), exists: false }
          : {
              name: slot.slot.slotName,
              active: slot.slot.active,
              walStatus: slot.slot.walStatus,
              lagBytes: slot.slot.lagBytes,
            },
      consumerLag:
        lag === undefined
          ? null
          : {
              at: lag.at,
              total: lag.totalLag,
              topics: Object.fromEntries(
                lag.topics.map((t) => [t.topic, 'error' in t ? null : t.lag]),
              ),
            },
    };
    if (problems.length === 0) return indicatorResult(key, 'up', details);
    return indicatorResult(key, 'degraded', { ...details, message: problems.join(' | ') });
  }

  /** The slot row (a seam for unit tests). */
  readSlot(name: string): Promise<ReplicationSlotState | undefined> {
    return readReplicationSlot(this.db, name);
  }

  private async checkConnector(): Promise<ConnectorCheck | undefined> {
    const baseUrl = this.config.get('KAFKA_CONNECT_URL');
    if (baseUrl === undefined) return undefined;
    return checkConnector(baseUrl, this.config.get('DEBEZIUM_CONNECTOR_NAME'), {
      timeoutMs: PIPELINE_PROBE_TIMEOUT_MS,
    });
  }

  private async checkSlot(): Promise<SlotCheck> {
    const name = this.config.get('OUTBOX_REPLICATION_SLOT');
    let slot: ReplicationSlotState | undefined;
    try {
      slot = await withTimeout(this.readSlot(name), PIPELINE_PROBE_TIMEOUT_MS);
    } catch (error) {
      // The full error goes to the log; the probe body stays generic (the database detail
      // reports reachability on its own).
      this.logger.warn({ err: error }, 'Replication slot check failed');
      return { ok: false, message: 'Replication slot state unavailable' };
    }
    if (slot === undefined) {
      return {
        ok: false,
        message: `Replication slot ${name} does not exist (Debezium creates it on its first start)`,
      };
    }
    if (slot.walStatus === 'lost') {
      return {
        ok: false,
        slot,
        message: `Replication slot ${name} is lost (WAL removed): events since its last confirmation can't be streamed; recreate the connector and re-publish from outbox.events`,
      };
    }
    if (!slot.active) {
      return {
        ok: false,
        slot,
        message: `Replication slot ${name} is not active: Debezium is not streaming (WAL is retained meanwhile)`,
      };
    }
    return { ok: true, slot };
  }
}
