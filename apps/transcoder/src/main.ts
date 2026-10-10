import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { attachLogger } from '@udemy/nest-common';
import { TranscoderConfigService } from './shared/config';
import { TranscoderModule } from './transcoder.module';

async function bootstrap(): Promise<void> {
  // Module init runs the ffmpeg/ffprobe version check (>= 6): a bad toolchain fails the boot here.
  const app = await NestFactory.create(TranscoderModule, { bufferLogs: true });
  attachLogger(app);
  // SIGTERM/SIGINT -> stop leasing -> kill ffmpeg (SIGTERM, then SIGKILL) -> release leases
  // without penalty -> close the pg pool and the S3 sockets.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  // listen() runs onApplicationBootstrap first, which starts LISTEN, the poll and the reaper.
  const port = app.get(TranscoderConfigService).get('TRANSCODER_HEALTH_PORT');
  await app.listen(port);
  new Logger('Bootstrap').log(
    `Transcoder running; probes on http://localhost:${port}/health/{live,ready}`,
  );
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `Fatal: transcoder failed to start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
