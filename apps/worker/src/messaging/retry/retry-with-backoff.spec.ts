import { describe, expect, it, vi } from 'vitest';
import { computeBackoffDelay, RetriesExhaustedError, retryWithBackoff } from './retry-with-backoff';

const policy = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

/** Records requested delays instead of waiting. */
function fakeSleep() {
  return vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);
}

describe('computeBackoffDelay', () => {
  it('doubles per retry and is capped at maxDelayMs (no jitter: random = 1)', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => computeBackoffDelay(n, policy, () => 1));

    expect(delays).toEqual([100, 200, 400, 800, 1_000]);
  });

  it('keeps at least half of the exponential delay (random = 0)', () => {
    expect(computeBackoffDelay(3, policy, () => 0)).toBe(200);
  });
});

describe('retryWithBackoff', () => {
  it('returns as soon as an attempt succeeds, sleeping with growing delays in between', async () => {
    const sleep = fakeSleep();
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValue('ok');

    await expect(retryWithBackoff(operation, { ...policy, sleep, random: () => 1 })).resolves.toBe(
      'ok',
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  it('gives up after maxRetries + 1 attempts with the last error as cause', async () => {
    const sleep = fakeSleep();
    const lastError = new Error('still down');
    const operation = vi.fn(async () => {
      throw lastError;
    });

    const failure = retryWithBackoff(operation, { ...policy, sleep });

    await expect(failure).rejects.toBeInstanceOf(RetriesExhaustedError);
    await expect(failure).rejects.toMatchObject({ attempts: 4, cause: lastError });
    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('does not retry errors that are not retryable', async () => {
    const sleep = fakeSleep();
    const operation = vi.fn(async () => {
      throw new Error('malformed');
    });

    await expect(
      retryWithBackoff(operation, { ...policy, sleep, isRetryable: () => false }),
    ).rejects.toMatchObject({ attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops waiting when aborted (graceful shutdown)', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw new Error('fails');
    });

    await expect(
      retryWithBackoff(operation, {
        ...policy,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
