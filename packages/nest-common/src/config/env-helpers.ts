import { z } from 'zod';

/** TCP port from an env string. */
export const envPort = z.coerce.number().int().min(1).max(65_535);

/** Non-negative integer from an env string (timeouts, limits, counts). */
export const envInt = z.coerce.number().int().min(0);

/** `true/false/1/0/yes/no/on/off` from an env string. */
export const envBoolean = z.stringbool();

/**
 * Comma-separated list, e.g. `CORS_ORIGINS=http://a,http://b` or `KAFKA_BROKERS=k1:9092,k2:9092`.
 * Blank items are dropped; each item is validated with `item`.
 */
export function envList<TItem extends z.ZodType<string, string>>(item: TItem) {
  return z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item));
}
