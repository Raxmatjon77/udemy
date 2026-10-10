import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DEAD_LETTER_PUBLISHER } from './dead-letter/dead-letter';
import { EventHandlerRegistry } from './event-handler.registry';
import { IdempotentEventProcessor } from './idempotency/idempotent-event-processor';
import { ConsumerLagReporter } from './kafka/consumer-lag.reporter';
import { KafkaConsumerService } from './kafka/kafka-consumer.service';
import { KafkaDeadLetterPublisher } from './kafka/kafka-dead-letter.publisher';
import { KafkaGroupMembership } from './kafka/kafka-group-membership';
import {
  kafkaAdminProvider,
  kafkaConsumerProvider,
  kafkaMonitoringAdminProvider,
  kafkaProducerProvider,
} from './kafka/kafka.providers';
import { MessageDispatcher } from './message-dispatcher';
import { retryPolicyProvider } from './retry/retry-policy.provider';

@Module({
  imports: [DiscoveryModule],
  providers: [
    EventHandlerRegistry,
    IdempotentEventProcessor,
    MessageDispatcher,
    retryPolicyProvider,
    KafkaGroupMembership,
    kafkaConsumerProvider,
    kafkaProducerProvider,
    kafkaAdminProvider,
    kafkaMonitoringAdminProvider,
    { provide: DEAD_LETTER_PUBLISHER, useClass: KafkaDeadLetterPublisher },
    KafkaConsumerService,
    ConsumerLagReporter,
  ],
  exports: [KafkaConsumerService, ConsumerLagReporter],
})
export class MessagingModule {}
