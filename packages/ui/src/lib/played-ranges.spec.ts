import { describe, expect, it } from 'vitest';

import { mergePlayedRanges, PlayedRangeTracker } from './played-ranges';

/** Feeds samples like `timeupdate` would. */
function play(tracker: PlayedRangeTracker, from: number, to: number, step = 0.25) {
  for (let t = from; t <= to + 1e-9; t += step) tracker.observe(Math.round(t * 100) / 100);
}

describe('PlayedRangeTracker', () => {
  it('reports continuous playback as one range', () => {
    const tracker = new PlayedRangeTracker();
    play(tracker, 10, 20);
    expect(tracker.take()).toEqual([{ from: 10, to: 20 }]);
    expect(tracker.position).toBe(20);
  });

  it('a seek forward closes the range: skipping never counts as watched', () => {
    const tracker = new PlayedRangeTracker();
    play(tracker, 0, 5);
    tracker.cut(); // seeking
    play(tracker, 280, 285);
    expect(tracker.take()).toEqual([
      { from: 0, to: 5 },
      { from: 280, to: 285 },
    ]);
  });

  it('a jump larger than the step (no seeking event) also splits the range', () => {
    const tracker = new PlayedRangeTracker({ maxStepSeconds: 4 });
    play(tracker, 0, 3);
    play(tracker, 100, 102);
    expect(tracker.take()).toEqual([
      { from: 0, to: 3 },
      { from: 100, to: 102 },
    ]);
  });

  it('2x playback still counts as continuous', () => {
    const tracker = new PlayedRangeTracker();
    play(tracker, 0, 30, 0.5);
    expect(tracker.take()).toEqual([{ from: 0, to: 30 }]);
  });

  it('take() splits the open range and keeps tracking, so both halves are reported', () => {
    const tracker = new PlayedRangeTracker();
    play(tracker, 0, 15);
    expect(tracker.take()).toEqual([{ from: 0, to: 15 }]);
    play(tracker, 15.25, 30);
    expect(tracker.take()).toEqual([{ from: 15, to: 30 }]);
    expect(tracker.take()).toEqual([]);
  });

  it('cut(at) extends to the final sample (pause), jumpTo() moves without counting', () => {
    const tracker = new PlayedRangeTracker();
    play(tracker, 0, 9.75);
    tracker.cut(10);
    tracker.jumpTo(200);
    expect(tracker.position).toBe(200);
    tracker.observe(200);
    tracker.observe(201);
    expect(tracker.take()).toEqual([
      { from: 0, to: 10 },
      { from: 200, to: 201 },
    ]);
  });

  it('merges re-watched (overlapping) ranges and ignores invalid samples', () => {
    const tracker = new PlayedRangeTracker();
    play(tracker, 0, 10);
    tracker.cut();
    play(tracker, 5, 12);
    tracker.observe(Number.NaN);
    tracker.observe(-1);
    expect(tracker.take()).toEqual([{ from: 0, to: 12 }]);
  });
});

describe('mergePlayedRanges', () => {
  it('sorts, merges touching ranges and drops empty ones', () => {
    expect(
      mergePlayedRanges([
        { from: 20, to: 30 },
        { from: 0, to: 10 },
        { from: 10, to: 15 },
        { from: 40, to: 40 },
      ]),
    ).toEqual([
      { from: 0, to: 15 },
      { from: 20, to: 30 },
    ]);
  });
});
