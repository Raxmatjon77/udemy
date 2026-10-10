import type { IncomingMessage } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { BaseEnv } from '../config/base-env.schema';
import { sanitizePresignedUrls } from './presigned-url';
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

/**
 * Where presigned URLs show up in logged objects (design §9: signed URLs are bearer
 * capabilities): `url` / `urls[*]` (plain strings or `{ partNumber, url }` as in
 * `PresignPartsResponse`) at the top level and one or two levels deep (`{ res: { body: … } }`),
 * and everything under a `responseBody`. These values are NOT censored wholesale (`req.url`
 * must stay readable): `logRedactCensor` strips the signing query parameters (`X-Amz-*`,
 * `Signature`, `AWSAccessKeyId`) from every presigned URL in them (also inside text, e.g. a
 * playlist) and censors `SENSITIVE_FIELD_NAMES` keys inside them; the rest is kept.
 */
export const PRESIGNED_URL_REDACT_PATHS: readonly string[] = [
  ...['', '*.', '*.*.'].flatMap((at) => [`${at}url`, `${at}urls[*]`, `${at}urls[*].url`]),
  'responseBody',
  '*.responseBody',
];

/** Every path the apps' pino logger redacts: credentials, then presigned URLs. */
export const LOG_REDACT_ALL_PATHS: readonly string[] = [
  ...LOG_REDACT_PATHS,
  ...PRESIGNED_URL_REDACT_PATHS,
];

const SENSITIVE_KEYS: ReadonlySet<string> = new Set(SENSITIVE_FIELD_NAMES);

function isPresignedUrlPath(path: readonly string[]): boolean {
  const last = path.at(-1);
  if (last === undefined || SENSITIVE_KEYS.has(last)) return false;
  if (last === 'url' || last === 'responseBody') return true;
  // `urls[*]`: […, 'urls', '<index>']
  return path.at(-2) === 'urls';
}

/**
 * The pino `redact.censor` function: presigned-URL paths (`PRESIGNED_URL_REDACT_PATHS`) keep
 * their value minus the signing parameters; every other path (credentials, tokens, cookies)
 * becomes `LOG_REDACT_CENSOR`.
 */
export function logRedactCensor(value: unknown, path: readonly string[]): unknown {
  if (value === undefined) return undefined;
  // Sensitive keys inside a sanitized subtree are censored too: pino skips the deeper credential
  // paths once a parent (e.g. `responseBody`) is redacted.
  return isPresignedUrlPath(path)
    ? sanitizePresignedUrls(value, { censorKeys: SENSITIVE_KEYS, censor: LOG_REDACT_CENSOR })
    : LOG_REDACT_CENSOR;
}

/** The `redact` option of the apps' pino logger (also usable with a plain `pino()`). */
export function logRedactOptions(): {
  paths: string[];
  censor: (value: unknown, path: string[]) => unknown;
} {
  return { paths: [...LOG_REDACT_ALL_PATHS], censor: logRedactCensor };
}

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
      redact: logRedactOptions(),
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
