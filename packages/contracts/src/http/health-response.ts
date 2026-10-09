import { z } from 'zod';

const HealthIndicatorResultSchema = z.record(
  z.string(),
  z.looseObject({ status: z.enum(['up', 'degraded', 'down']) }),
);

/** Shape returned by `/health/live` and `/health/ready` (matches @nestjs/terminus). */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error', 'shutting_down']),
  info: HealthIndicatorResultSchema.optional(),
  error: HealthIndicatorResultSchema.optional(),
  details: HealthIndicatorResultSchema,
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
