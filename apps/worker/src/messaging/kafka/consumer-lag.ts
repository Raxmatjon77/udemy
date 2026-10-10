import type { KafkaJS } from '@confluentinc/kafka-javascript';

export interface PartitionLag {
  readonly partition: number;
  /** Next offset the group will read; null when the group never committed on this partition. */
  readonly committed: string | null;
  readonly low: string;
  readonly high: string;
  /** Messages not consumed yet: high - committed (or high - low without a commit). */
  readonly lag: number;
}

export type TopicLag =
  | { readonly topic: string; readonly lag: number; readonly partitions: readonly PartitionLag[] }
  | { readonly topic: string; readonly error: string };

/** The two read-only admin calls the lag needs (the fake in tests implements just these). */
export type LagAdmin = Pick<KafkaJS.Admin, 'fetchOffsets' | 'fetchTopicOffsets'>;

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Per-partition lag of one partition from its watermarks and the group's committed offset. */
export function partitionLag(
  partition: number,
  watermarks: { low: string; high: string },
  committedOffset: string | undefined,
): PartitionLag {
  const high = BigInt(watermarks.high);
  const low = BigInt(watermarks.low);
  // -1 (or absent) = nothing committed: with fromBeginning the group starts at the low watermark.
  const committed =
    committedOffset === undefined || BigInt(committedOffset) < 0n ? null : committedOffset;
  // A committed offset below `low` (retention deleted messages) still means "starts at low".
  const position = committed === null ? low : maxBig(BigInt(committed), low);
  return {
    partition,
    committed,
    low: watermarks.low,
    high: watermarks.high,
    lag: Number(maxBig(high - position, 0n)),
  };
}

/**
 * Lag of `groupId` on every topic: committed offset (OffsetFetch, read-only: it neither joins
 * nor moves the group) vs. the high watermark. One failing topic does not hide the others.
 */
export async function fetchConsumerLag(
  admin: LagAdmin,
  groupId: string,
  topics: readonly string[],
): Promise<TopicLag[]> {
  const committedByTopic = new Map<string, Map<number, string>>();
  const offsets = await admin.fetchOffsets({ groupId, topics: [...topics] });
  for (const entry of offsets) {
    committedByTopic.set(
      entry.topic,
      new Map(entry.partitions.map((p) => [p.partition, p.offset] as const)),
    );
  }

  return Promise.all(
    topics.map(async (topic): Promise<TopicLag> => {
      try {
        const watermarks = await admin.fetchTopicOffsets(topic);
        const committed = committedByTopic.get(topic);
        const partitions = watermarks
          .map((w) => partitionLag(w.partition, w, committed?.get(w.partition)))
          .sort((a, b) => a.partition - b.partition);
        return { topic, lag: partitions.reduce((sum, p) => sum + p.lag, 0), partitions };
      } catch (error) {
        return { topic, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
