import { setTimeout as sleepFor } from 'node:timers/promises';

export interface RetryPolicy {
  /** Retries after the first attempt; total attempts = maxRetries + 1. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryOptions extends RetryPolicy {
  /** Return false to stop immediately (e.g. for malformed input). Default: always retry. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, retryNumber: number, delayMs: number) => void;
  /** Aborting (graceful shutdown) interrupts the wait and rejects with an AbortError. */
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Thrown when an operation keeps failing; `cause` is the last error. */
export class RetriesExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`Gave up after ${attempts} attempt(s)`, { cause });
    this.name = 'RetriesExhaustedError';
  }
}

/**
 * Exponential backoff with "equal jitter": base * 2^(n-1), capped at maxDelayMs, of which
 * the upper half is random. The jitter spreads out replicas that failed at the same moment
 * (e.g. after a DB blip), the fixed half guarantees a minimum pause.
 */
export function computeBackoffDelay(
  retryNumber: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryNumber - 1));
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

const defaultSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await sleepFor(ms, undefined, { signal });
};

export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const retryable = options.isRetryable?.(error) ?? true;
      if (!retryable || attempt > options.maxRetries) {
        throw new RetriesExhaustedError(attempt, error);
      }
      const delayMs = computeBackoffDelay(attempt, options, options.random);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs, options.signal);
    }
  }
}
