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

/** Body/DTO fields that hold credentials or tokens (design §9 "Audit"). */
export const SENSITIVE_FIELD_NAMES = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'refreshToken',
  'accessToken',
] as const;

/**
 * Pino redact paths, relative to the serialized log object (pino-http's `req` / `res`, or the
 * object passed to `logger.info({...})`). Sensitive fields are matched at the top level and
 * one or two levels deep, so `{ password }`, `{ body: { password } }` and
 * `{ req: { body: { password } } }` are all censored.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-client-secret"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_FIELD_NAMES.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
];

export const LOG_REDACT_CENSOR = '[REDACTED]';

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
      redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
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
