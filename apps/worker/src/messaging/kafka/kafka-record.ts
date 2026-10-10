import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { InboundRecord } from '../envelope/inbound-record';

/** Client message -> transport-neutral InboundRecord (also used by the DLQ CLI client). */
export function toInboundRecord(
  topic: string,
  partition: number,
  message: KafkaJS.KafkaMessage,
): InboundRecord {
  return {
    topic,
    partition,
    offset: message.offset,
    key: message.key,
    value: message.value,
    headers: message.headers ?? {},
    timestamp: message.timestamp,
  };
}
