import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

/**
 * Routes all Nest logging (including `new Logger(Context)` from @nestjs/common) through pino.
 * Create the app with `{ bufferLogs: true }` so bootstrap logs are flushed through pino too.
 */
export function attachLogger(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.flushLogs();
}
