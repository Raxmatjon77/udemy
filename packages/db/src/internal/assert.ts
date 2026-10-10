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

/** numeric(12,2) as a decimal string ('19.99', '0', '-5.00'); JS numbers are never accepted for money. */
const MONEY_RE = /^-?\d{1,10}(\.\d{1,2})?$/;

export function assertMoney(
  name: string,
  value: string,
  opts: { allowNegative?: boolean } = {},
): void {
  if (
    typeof value !== 'string' ||
    !MONEY_RE.test(value) ||
    (!opts.allowNegative && value.startsWith('-'))
  ) {
    throw new RangeError(
      `${name} must be a decimal string with at most 2 decimals, got ${String(value)}`,
    );
  }
}

export function assertCurrency(name: string, value: string): void {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new RangeError(`${name} must be an upper-case ISO 4217 code, got ${String(value)}`);
  }
}

/** Fails before the database for values a CHECK would reject anyway (clearer error, no round trip). */
export function assertOneOf<T extends string>(name: string, value: T, allowed: readonly T[]): void {
  if (!allowed.includes(value)) {
    throw new RangeError(`${name} must be one of ${allowed.join(', ')}, got ${String(value)}`);
  }
}
