import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';
import { AppConfigService } from './shared/config';

async function bootstrap(): Promise<void> {
  // bufferLogs: hold bootstrap logs until pino is attached in setupApp.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  setupApp(app);

  const port = app.get(AppConfigService).get('PORT');
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on http://localhost:${port}/api (docs: /api/docs)`);
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid env), so write straight to stderr.
  process.stderr.write(
    `Fatal: API failed to start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
