import { Logger } from '@nestjs/common';
import { type EventEnvelope, SystemPing } from '@udemy/contracts';
import { ANY_EVENT_TYPE, EventHandler, type EventHandlerContract } from '../messaging';

/**
 * Logs every envelope on `system.ping` (SystemPing's aggregateType, which Debezium uses as
 * the topic). Smoke test for the outbox -> Debezium -> Kafka -> worker pipeline:
 * insert a SystemPing through the api's OutboxPublisher and watch the worker log it once.
 */
@EventHandler(SystemPing.aggregateType, ANY_EVENT_TYPE)
export class DebugEventHandler implements EventHandlerContract {
  private readonly logger = new Logger(DebugEventHandler.name);

  async handle(envelope: EventEnvelope): Promise<void> {
    if (SystemPing.matches(envelope)) {
      // Validate against the contract: a ZodError here goes to the DLQ without retries.
      const payload = SystemPing.parsePayload(envelope.payload);
      this.logger.log({ envelope }, `SystemPing received: ${payload.message}`);
      return;
    }
    this.logger.log({ envelope }, `Event received: ${envelope.eventType} v${envelope.version}`);
  }
}
