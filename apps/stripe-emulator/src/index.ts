/**
 * In-process entry for test harnesses (API e2e global setup, Playwright helpers):
 * `startEmulator(emulatorConfig({ secretKey, webhookSecret, webhookUrl }), { port: 0, host:
 * '127.0.0.1' })`. The standalone process is `dist/main.js`.
 */
export type { EmulatorConfig, ListenConfig } from './config';
export {
  DEFAULT_PORT,
  emulatorConfig,
  emulatorConfigFromEnv,
  EmulatorConfigError,
  listenConfigFromEnv,
} from './config';
export type { Logger, LogLevel } from './logger';
export { jsonLogger, silentLogger } from './logger';
export type { EmulatorDependencies, RunningEmulator } from './server';
export { startEmulator } from './server';
export type { RefundOutcome, RefundPlan } from './stripe/emulator';
export type {
  DeliveryAttempt,
  DeliveryStatus,
  EventSummary,
  StripeEvent,
  TamperMode,
} from './webhooks/dispatcher';
