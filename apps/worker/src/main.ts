import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { attachLogger } from '@udemy/nest-common';
import { WorkerConfigService } from './shared/config';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });
  attachLogger(app);
  // SIGTERM -> stop consuming (offsets committed) -> close producer -> close the pg pool.
  app.enableShutdownHooks();

  // listen() runs onApplicationBootstrap first, which connects Kafka and starts consuming.
  const port = app.get(WorkerConfigService).get('WORKER_HEALTH_PORT');
  await app.listen(port);
  new Logger('Bootstrap').log(
    `Worker running; probes on http://localhost:${port}/health/{live,ready}`,
  );
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `Fatal: worker failed to start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
