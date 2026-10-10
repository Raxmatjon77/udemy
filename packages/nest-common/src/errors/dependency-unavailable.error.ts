/**
 * A required infrastructure dependency (Redis, SMTP, ...) is unreachable or timed out.
 *
 * Not a DomainError: it says nothing about the request, only that the service cannot serve it
 * right now. The api's global filter maps it to `503 service_unavailable` with a generic
 * detail (the dependency name and the cause go to the log only). Fail-closed code paths
 * (design D11: revocation checks, rate limits) throw it instead of letting the request through.
 */
export class DependencyUnavailableError extends Error {
  constructor(
    /** Short, log-only name of the dependency, e.g. `redis`. Never sent to clients. */
    readonly dependency: string,
    options: { cause?: unknown } = {},
  ) {
    super(`Dependency unavailable: ${dependency}`, { cause: options.cause });
    this.name = new.target.name;
  }
}

export function isDependencyUnavailableError(error: unknown): error is DependencyUnavailableError {
  return error instanceof DependencyUnavailableError;
}
