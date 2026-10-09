/**
 * Structurally identical to @nestjs/terminus' `HealthIndicatorResult`. Defined here so this
 * package does not import terminus: terminus has many optional peers, and a second copy of
 * it (resolved with different peers) would break Nest's class-based DI tokens.
 */
export type HealthStatus = 'up' | 'degraded' | 'down';

export type HealthIndicatorResult<TKey extends string = string> = Record<
  TKey,
  { status: HealthStatus } & Record<string, unknown>
>;

/** Builds `{ [key]: { status, ...data } }` with the key's literal type preserved. */
export function indicatorResult<TKey extends string>(
  key: TKey,
  status: HealthStatus,
  data: Record<string, unknown> = {},
): HealthIndicatorResult<TKey> {
  const entry: { status: HealthStatus } & Record<string, unknown> = { ...data, status };
  return { [key]: entry } as Record<TKey, typeof entry>;
}
