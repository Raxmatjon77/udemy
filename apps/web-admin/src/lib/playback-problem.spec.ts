import { describe, expect, it } from 'vitest';

import { describePlaybackProblem } from './playback-problem';

describe('describePlaybackProblem (admin revision)', () => {
  it.each([
    [403, 'forbidden', false, /do not have permission/],
    [404, 'not_found', false, /not part of this revision/],
    [409, 'media_not_ready', true, /not ready to play/],
    [422, 'lecture_type_mismatch', false, /not a video lecture/],
    [429, 'rate_limited', true, /Too many playback requests/],
  ] as const)('%i %s', (status, code, retryable, message) => {
    const view = describePlaybackProblem({ status, code, retryAfterSeconds: null });
    expect(view.retryable).toBe(retryable);
    expect(view.message).toMatch(message);
  });

  it('carries Retry-After for a 429', () => {
    expect(
      describePlaybackProblem({ status: 429, code: 'rate_limited', retryAfterSeconds: 30 }),
    ).toEqual({
      message: 'Too many playback requests. Try again in 30 seconds.',
      retryable: true,
      retryAfterSeconds: 30,
    });
  });
});
