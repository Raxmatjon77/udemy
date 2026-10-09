import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DEAD_LETTER_PUBLISHER } from './dead-letter/dead-letter';
import { EventHandlerRegistry } from './event-handler.registry';
import { IdempotentEventProcessor } from './idempotency/idempotent-event-processor';
import { KafkaConsumerService } from './kafka/kafka-consumer.service';
import { KafkaDeadLetterPublisher } from './kafka/kafka-dead-letter.publisher';
import { KafkaGroupMembership } from './kafka/kafka-group-membership';
import {
  kafkaAdminProvider,
  kafkaConsumerProvider,
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
    { provide: DEAD_LETTER_PUBLISHER, useClass: KafkaDeadLetterPublisher },
    KafkaConsumerService,
  ],
  exports: [KafkaConsumerService],
})
export class MessagingModule {}
