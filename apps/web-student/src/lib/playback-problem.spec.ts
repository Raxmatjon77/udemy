import { describe, expect, it } from 'vitest';

import { describePlaybackProblem } from './playback-problem';

describe('describePlaybackProblem (live catalog)', () => {
  it.each([
    [403, 'lecture_locked', false, /not available as a free preview/],
    [404, 'course_not_found', false, /not available/],
    [409, 'media_not_ready', true, /not available right now/],
    [422, 'lecture_type_mismatch', false, /not a video/],
    [429, 'rate_limited', true, /Too many playback requests/],
  ] as const)('%i %s', (status, code, retryable, message) => {
    const view = describePlaybackProblem({ status, code, retryAfterSeconds: null });
    expect(view.retryable).toBe(retryable);
    expect(view.message).toMatch(message);
  });

  it('a 429 without Retry-After asks to wait a little', () => {
    expect(describePlaybackProblem({ status: 429, code: null, retryAfterSeconds: null })).toEqual({
      message: 'Too many playback requests. Please wait a little and try again.',
      retryable: true,
      retryAfterSeconds: null,
    });
  });
});
