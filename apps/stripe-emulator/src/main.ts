import { emulatorConfigFromEnv, listenConfigFromEnv } from './config';
import { errorMessage, jsonLogger } from './logger';
import { startEmulator } from './server';

const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const logger = jsonLogger(process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info');
  const emulator = await startEmulator(emulatorConfigFromEnv(), listenConfigFromEnv(), { logger });

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    logger.log('info', 'shutting down', { signal });
    const force = setTimeout(() => {
      emulator.server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    emulator.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.log('error', 'shutdown failed', { error: errorMessage(error) });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', service: 'stripe-emulator', msg: 'startup failed', error: errorMessage(error) })}\n`,
  );
  process.exit(1);
});
