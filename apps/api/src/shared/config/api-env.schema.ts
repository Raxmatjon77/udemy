import { baseEnvSchema, envBoolean, envInt, envList, envPort } from '@udemy/nest-common';
import { z } from 'zod';

/** Everything the api process reads from the environment. Validated once at startup. */
export const apiEnvSchema = baseEnvSchema.extend({
  PORT: envPort.default(4000),
  /** Browser origins allowed by CORS, comma separated. Empty = no cross-origin access. */
  CORS_ORIGINS: envList(z.url()).default([]),
  /** Number of reverse proxies in front of the app (ingress, LB); 0 = none. Drives req.ip. */
  TRUST_PROXY_HOPS: envInt.default(1),
  SWAGGER_ENABLED: envBoolean.default(true),
  /** Global rate limit: THROTTLE_LIMIT requests per THROTTLE_TTL_MS per client IP. */
  THROTTLE_TTL_MS: envInt.min(1).default(60_000),
  THROTTLE_LIMIT: envInt.min(1).default(120),
});

export type ApiEnv = z.output<typeof apiEnvSchema>;
