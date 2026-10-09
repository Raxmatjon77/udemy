import type { IncomingMessage } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { BaseEnv } from '../config/base-env.schema';
import { resolveCorrelationId, resolveRequestId } from './request-id';

export interface CreateLoggerModuleOptions {
  /** Added to every log line as `service`, e.g. `udemy-api`. */
  serviceName: string;
}

/** Paths are relative to the serialized log object (pino-http's `req` / `res`). */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/** Kubernetes probes hit these every few seconds; logging them is pure noise. */
function isHealthProbe(req: IncomingMessage): boolean {
  return req.url?.includes('/health/') ?? false;
}

export function buildPinoParams(
  env: Pick<BaseEnv, 'NODE_ENV' | 'LOG_LEVEL'>,
  options: CreateLoggerModuleOptions,
): Params {
  const pretty = env.NODE_ENV === 'development';
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      base: { service: options.serviceName },
      // Dev: human readable. Prod: one JSON object per line for Loki / ELK.
      transport: pretty
        ? {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          }
        : undefined,
      genReqId: (req, res) => resolveRequestId(req, res),
      customProps: (req) => ({ correlationId: resolveCorrelationId(req, String(req.id)) }),
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      autoLogging: { ignore: isHealthProbe },
    },
  };
}

/**
 * nestjs-pino logger. Every log line written during a request carries `req.id` and
 * `correlationId`, also when you log via Nest's `Logger` from `@nestjs/common`
 * (after `useLogger(app.get(Logger))`, see `attachLogger`).
 */
export function createLoggerModule(options: CreateLoggerModuleOptions): DynamicModule {
  return LoggerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService<BaseEnv, true>): Params =>
      buildPinoParams(
        {
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
        },
        options,
      ),
  });
}
