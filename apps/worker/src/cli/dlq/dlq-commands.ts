import {
  DEAD_LETTER_SUFFIX,
  DLQ_HEADER_PREFIX,
  DLQ_HEADERS,
} from '../../messaging/dead-letter/dead-letter';
import type { DlqClient, OutboundRecord } from '../../messaging/dead-letter/dlq-client';
import {
  headerToString,
  type InboundRecord,
  type RecordHeaders,
} from '../../messaging/envelope/inbound-record';
import { OUTBOX_HEADERS } from '../../messaging/envelope/parse-envelope';
import { CliUsageError } from '../cli-usage.error';

/** A command failed for a reason the operator must see (exit code 1, not a stack trace). */
export class CliCommandError extends Error {}

/** Where the commands write: one JSON document per line on stdout, notes on stderr. */
export interface CliOutput {
  line(value: unknown): void;
  note(message: string): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `identity.user.dlq` -> `identity.user`; refuses anything that is not a DLQ topic. */
export function originalTopicOf(dlqTopic: string): string {
  if (!dlqTopic.endsWith(DEAD_LETTER_SUFFIX) || dlqTopic.length <= DEAD_LETTER_SUFFIX.length) {
    throw new CliUsageError(
      `Expected a DLQ topic (<topic>${DEAD_LETTER_SUFFIX}), got "${dlqTopic}"`,
    );
  }
  const original = dlqTopic.slice(0, -DEAD_LETTER_SUFFIX.length);
  if (original.endsWith(DEAD_LETTER_SUFFIX)) {
    throw new CliUsageError(`Refusing a DLQ of a DLQ: "${dlqTopic}"`);
  }
  return original;
}

/** The value as UTF-8, cut to `maxChars` (payloads may carry PII: print only a preview). */
export function payloadPreview(value: Buffer | null, maxChars: number): string | null {
  if (value === null) return null;
  const text = value.toString('utf8');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [${value.length - Buffer.byteLength(text.slice(0, maxChars))} more bytes redacted]`;
}

/** Original headers without the `dlq.*` ones: exactly what the consumer saw the first time. */
export function stripDlqHeaders(headers: RecordHeaders): RecordHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.startsWith(DLQ_HEADER_PREFIX)),
  );
}

function header(record: InboundRecord, name: string): string | undefined {
  return headerToString(record.headers[name]);
}

function isoOrNull(millis: string): string | null {
  const n = Number(millis);
  return Number.isFinite(n) && n >= 0 ? new Date(n).toISOString() : null;
}

/** One line of `dlq:list`. */
export function describeDlqRecord(record: InboundRecord, previewChars: number): object {
  const attempts = header(record, DLQ_HEADERS.attempts);
  return {
    partition: record.partition,
    offset: record.offset,
    timestamp: isoOrNull(record.timestamp),
    key: record.key?.toString('utf8') ?? null,
    eventType: header(record, OUTBOX_HEADERS.eventType) ?? null,
    eventId: header(record, OUTBOX_HEADERS.eventId) ?? null,
    dlq: {
      originalTopic: header(record, DLQ_HEADERS.originalTopic) ?? null,
      originalPartition: header(record, DLQ_HEADERS.originalPartition) ?? null,
      originalOffset: header(record, DLQ_HEADERS.originalOffset) ?? null,
      consumer: header(record, DLQ_HEADERS.consumer) ?? null,
      errorName: header(record, DLQ_HEADERS.errorName) ?? null,
      errorMessage: header(record, DLQ_HEADERS.errorMessage) ?? null,
      attempts: attempts === undefined ? null : Number(attempts),
      failedAt: header(record, DLQ_HEADERS.failedAt) ?? null,
    },
    payloadBytes: record.value?.length ?? 0,
    payloadPreview: payloadPreview(record.value, previewChars),
  };
}

export interface ListOptions {
  readonly topic: string;
  readonly limit: number;
  readonly previewChars: number;
}

export interface ListSummary {
  readonly topic: string;
  readonly retained: number;
  readonly listed: number;
  readonly more: boolean;
}

/** `dlq:list`: the oldest `limit` messages of a DLQ topic, one JSON line each. */
export async function listDlq(
  client: DlqClient,
  options: ListOptions,
  out: CliOutput,
): Promise<ListSummary> {
  originalTopicOf(options.topic);
  const stats = await client.stats(options.topic);
  if (stats === undefined) throw new CliCommandError(`Topic ${options.topic} does not exist`);
  let listed = 0;
  let more = false;
  if (stats.messages > 0) {
    await client.scan(options.topic, (record) => {
      if (listed >= options.limit) {
        more = true;
        return false;
      }
      out.line(describeDlqRecord(record, options.previewChars));
      listed += 1;
      return true;
    });
  }
  const summary = { topic: options.topic, retained: stats.messages, listed, more };
  out.note(JSON.stringify({ summary }));
  return summary;
}

export interface ReplayOptions {
  readonly topic: string;
  /** Replay only the DLQ messages of this event; undefined = all (`--all`). */
  readonly eventId: string | undefined;
  readonly dryRun: boolean;
  /** Also replay messages older than the dedupe window (PROCESSED_EVENTS_RETENTION_DAYS). */
  readonly allowStale: boolean;
  readonly processedRetentionDays: number;
  readonly now: Date;
}

export type ReplaySkipReason =
  /** No `eventId` header: the message was unreadable; replaying it would fail the same way. */
  | 'no_event_id'
  /** Its `dlq.original.topic` is a different topic than the one this DLQ belongs to. */
  | 'other_topic'
  /** Same event already replayed in this run (it failed for several handlers). */
  | 'duplicate_event'
  /** Failed longer ago than the dedupe window: handlers that succeeded may have lost their row. */
  | 'stale';

export interface ReplaySummary {
  readonly topic: string;
  readonly targetTopic: string;
  readonly dryRun: boolean;
  readonly matched: number;
  readonly replayed: number;
  readonly skipped: Readonly<Partial<Record<ReplaySkipReason, number>>>;
}

function targetPartition(record: InboundRecord, partitions: number): number | undefined {
  const raw = header(record, DLQ_HEADERS.originalPartition);
  const partition = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(partition) && partition >= 0 && partition < partitions
    ? partition
    : undefined;
}

function failedAtMillis(record: InboundRecord): number {
  const failedAt = header(record, DLQ_HEADERS.failedAt);
  const parsed = failedAt === undefined ? Number.NaN : Date.parse(failedAt);
  return Number.isFinite(parsed) ? parsed : Number(record.timestamp);
}

/**
 * `dlq:replay`: republishes DLQ messages to their original topic with the original key, value
 * and headers (minus `dlq.*`), to the original partition (keeps per-key ordering among replays).
 *
 * Safe to repeat: the consumers are idempotent per (consumer, eventId), and a failed handler has
 * no `processed_events` row (its transaction rolled back), so the replay re-runs exactly the
 * handlers that failed; those that succeeded skip it as a duplicate. Kafka can't delete single
 * messages, so the DLQ copy stays; a second replay is harmless, only noisy.
 */
export async function replayDlq(
  client: DlqClient,
  options: ReplayOptions,
  out: CliOutput,
): Promise<ReplaySummary> {
  const targetTopic = originalTopicOf(options.topic);
  const [dlqStats, targetStats] = await Promise.all([
    client.stats(options.topic),
    client.stats(targetTopic),
  ]);
  if (dlqStats === undefined) throw new CliCommandError(`Topic ${options.topic} does not exist`);
  if (targetStats === undefined) {
    throw new CliCommandError(`Original topic ${targetTopic} does not exist`);
  }

  const staleBefore = options.now.getTime() - options.processedRetentionDays * DAY_MS;
  const seen = new Set<string>();
  const skipped: Partial<Record<ReplaySkipReason, number>> = {};
  const toPublish: OutboundRecord[] = [];
  let matched = 0;

  const skip = (record: InboundRecord, eventId: string | undefined, reason: ReplaySkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    out.line({
      action: 'skipped',
      reason,
      partition: record.partition,
      offset: record.offset,
      eventId: eventId ?? null,
    });
  };

  if (dlqStats.messages > 0) {
    await client.scan(options.topic, (record) => {
      const eventId = header(record, OUTBOX_HEADERS.eventId);
      if (options.eventId !== undefined && eventId !== options.eventId) return true;
      matched += 1;
      const originalTopic = header(record, DLQ_HEADERS.originalTopic);
      if (eventId === undefined) skip(record, eventId, 'no_event_id');
      else if (originalTopic !== undefined && originalTopic !== targetTopic) {
        skip(record, eventId, 'other_topic');
      } else if (seen.has(eventId)) skip(record, eventId, 'duplicate_event');
      else if (!options.allowStale && failedAtMillis(record) < staleBefore) {
        skip(record, eventId, 'stale');
      } else {
        seen.add(eventId);
        const partition = targetPartition(record, targetStats.partitions);
        toPublish.push({
          key: record.key,
          value: record.value,
          headers: stripDlqHeaders(record.headers),
          ...(partition === undefined ? {} : { partition }),
        });
        out.line({
          action: options.dryRun ? 'would_replay' : 'replay',
          partition: record.partition,
          offset: record.offset,
          eventId,
          eventType: header(record, OUTBOX_HEADERS.eventType) ?? null,
          targetTopic,
          targetPartition: partition ?? null,
        });
      }
      return true;
    });
  }

  if (options.eventId !== undefined && matched === 0) {
    throw new CliCommandError(`No message with eventId ${options.eventId} in ${options.topic}`);
  }
  if ((skipped.stale ?? 0) > 0) {
    out.note(
      `${skipped.stale} message(s) failed more than ${options.processedRetentionDays} days ago (PROCESSED_EVENTS_RETENTION_DAYS): handlers that already succeeded may no longer have their dedupe row and would run again. Re-run with --allow-stale only if every handler on ${targetTopic} tolerates that.`,
    );
  }
  if (!options.dryRun && toPublish.length > 0) {
    await client.publish(targetTopic, toPublish);
  }

  const summary: ReplaySummary = {
    topic: options.topic,
    targetTopic,
    dryRun: options.dryRun,
    matched,
    replayed: options.dryRun ? 0 : toPublish.length,
    skipped,
  };
  out.note(JSON.stringify({ summary }));
  return summary;
}
