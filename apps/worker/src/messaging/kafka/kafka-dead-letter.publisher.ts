import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildDeadLetterMessage,
  type DeadLetter,
  type DeadLetterPublisher,
} from '../dead-letter/dead-letter';
import { KAFKA_PRODUCER } from './kafka.providers';

/** Sends failed messages to `<topic>.dlq` (created at startup, see kafka-topics.ts). */
@Injectable()
export class KafkaDeadLetterPublisher implements DeadLetterPublisher {
  private readonly logger = new Logger(KafkaDeadLetterPublisher.name);

  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: KafkaJS.Producer) {}

  async publish(deadLetter: DeadLetter): Promise<void> {
    const message = buildDeadLetterMessage(deadLetter);
    await this.producer.send({
      topic: message.topic,
      messages: [{ key: message.key, value: message.value, headers: message.headers }],
    });
    this.logger.warn(
      {
        topic: message.topic,
        originalOffset: deadLetter.record.offset,
        consumer: deadLetter.consumerName,
      },
      'Message moved to DLQ',
    );
  }
}
