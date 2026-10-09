import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { deadLetterTopic } from '../dead-letter/dead-letter';

/** -1 means "use the broker default" (num.partitions / default.replication.factor). */
export interface TopicSettings {
  numPartitions: number;
  replicationFactor: number;
}

/** Each handler topic plus its `<topic>.dlq`, deduplicated. */
export function topicsToEnsure(topics: readonly string[]): string[] {
  return [...new Set(topics.flatMap((topic) => [topic, deadLetterTopic(topic)]))];
}

/**
 * Creates the topics that don't exist yet. Idempotent: createTopics skips existing topics
 * (TOPIC_ALREADY_EXISTS) and resolves false instead of failing.
 *
 * Why: librdkafka does not join the group while none of its subscribed topics exist, and only
 * notices a new topic on its next periodic metadata refresh. Topics created by Debezium after
 * the worker started would sit unconsumed until then.
 */
export async function ensureTopics(
  admin: Pick<KafkaJS.Admin, 'connect' | 'createTopics' | 'disconnect'>,
  topics: readonly string[],
  settings: TopicSettings,
): Promise<string[]> {
  const names = topicsToEnsure(topics);
  await admin.connect();
  try {
    await admin.createTopics({
      topics: names.map((topic) => ({ topic, ...settings })),
    });
  } finally {
    await admin.disconnect();
  }
  return names;
}
