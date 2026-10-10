/**
 * The database constraint behind an error, if any: the error itself or anything in its `cause`
 * chain (the transaction runner wraps known violations in domain errors and keeps the
 * driver error as the cause). Duck-typed on `{ code: string, constraint: string }` so the
 * application layer stays free of driver types.
 */
export function violatedConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.constraint === 'string') {
      return candidate.constraint;
    }
    current = candidate.cause;
  }
  return undefined;
}
