import { Logger } from '@nestjs/common';
import type { KafkaJS } from '@confluentinc/kafka-javascript';

/** Routes the Kafka client's logs through Nest (and therefore pino) instead of the console. */
export function createKafkaLogger(namespace = 'Kafka'): KafkaJS.Logger {
  const logger = new Logger(namespace);
  return {
    info: (message, extra) => logger.log({ ...extra }, message),
    warn: (message, extra) => logger.warn({ ...extra }, message),
    error: (message, extra) => logger.error({ ...extra }, message),
    debug: (message, extra) => logger.debug({ ...extra }, message),
    namespace: (child) => createKafkaLogger(`${namespace}:${child}`),
    // Level filtering is done by pino (LOG_LEVEL), so this is a no-op.
    setLogLevel: () => undefined,
  };
}
