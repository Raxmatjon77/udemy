import { describe, expect, it } from 'vitest';

import { describePlaybackProblem } from './playback-problem';

describe('describePlaybackProblem (working copy)', () => {
  it.each([
    [403, 'lecture_locked', false, /do not have access/],
    [404, 'lecture_not_found', false, /no longer exists/],
    [409, 'media_not_ready', true, /still being processed/],
    [422, 'lecture_type_mismatch', false, /not a video lecture/],
    [429, 'rate_limited', true, /Too many playback requests/],
  ] as const)('%i %s', (status, code, retryable, message) => {
    const view = describePlaybackProblem({ status, code, retryAfterSeconds: null });
    expect(view.retryable).toBe(retryable);
    expect(view.message).toMatch(message);
  });

  it('carries Retry-After for a 429', () => {
    expect(
      describePlaybackProblem({ status: 429, code: 'rate_limited', retryAfterSeconds: 120 }),
    ).toEqual({
      message: 'Too many playback requests. Try again in about 2 minutes.',
      retryable: true,
      retryAfterSeconds: 120,
    });
  });
});
