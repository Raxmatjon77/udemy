/** Shared argument guards for the operational SQL helpers (fail before reaching the database). */

export function assertIntInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${value}`);
  }
}

/** Upper bound for any batch/page size, so callers can't run unbounded statements. */
export const MAX_BATCH_SIZE = 10_000;

export function assertBatchSize(batchSize: number): void {
  assertIntInRange('batchSize', batchSize, 1, MAX_BATCH_SIZE);
}

export function assertNonEmptyText(name: string, value: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new RangeError(`${name} must be a string of 1..${maxLength} characters`);
  }
}
