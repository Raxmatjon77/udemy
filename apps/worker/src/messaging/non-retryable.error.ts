/**
 * Retrying cannot help (malformed message, contract violation). The dispatcher sends
 * such messages to the DLQ immediately instead of burning the retry budget.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
