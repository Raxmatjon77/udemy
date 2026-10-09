import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, indicatorResult } from '@udemy/nest-common';
import { KafkaConsumerService } from '../messaging/kafka/kafka-consumer.service';

@Injectable()
export class KafkaHealthIndicator {
  constructor(private readonly consumer: KafkaConsumerService) {}

  check<TKey extends string>(key: TKey): HealthIndicatorResult<TKey> {
    const reason = this.consumer.notReadyReason();
    return reason === undefined
      ? indicatorResult(key, 'up')
      : indicatorResult(key, 'down', { message: reason });
  }
}
