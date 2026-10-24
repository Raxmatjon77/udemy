import { coverageHexLiteral, coverageTextToBytes, countCoveredBuckets } from '@udemy/db';
import { describe, expect, it } from 'vitest';
import {
  assertClientCompletionAllowed,
  assertServerCompletionAllowed,
  courseProgressOf,
} from './completion-policy';
import { CompletionNotAllowed } from './learning.errors';
import {
  acceptPlayedRanges,
  bucketCountOf,
  bucketSpansOf,
  CoverageBitmap,
  coveragePctOf,
  meetsVideoCompletion,
  plausibilityBudgetSeconds,
} from './progress-rules';

const RULES = { factor: 2.5, slackSeconds: 10, firstSeconds: 60 };

describe('plausibility budget (D3)', () => {
  it('allows 60 s on the first heartbeat of a (user, lecture)', () => {
    expect(plausibilityBudgetSeconds(null, 1_000_000, RULES)).toBe(60);
  });

  it('allows elapsed x 2.5 + 10 s afterwards', () => {
    const last = 1_000_000;
    expect(plausibilityBudgetSeconds(last, last + 15_000, RULES)).toBe(47.5);
    expect(plausibilityBudgetSeconds(last, last, RULES)).toBe(10);
  });

  it('treats a clock that went backwards as no elapsed time', () => {
    expect(plausibilityBudgetSeconds(2_000_000, 1_000_000, RULES)).toBe(10);
  });
});

describe('acceptPlayedRanges', () => {
  it('keeps everything that fits, oldest first', () => {
    const { accepted, droppedSeconds } = acceptPlayedRanges(
      [
        { from: 0, to: 10 },
        { from: 10, to: 20 },
      ],
      100,
      60,
    );
    expect(accepted).toEqual([
      { from: 0, to: 10 },
      { from: 10, to: 20 },
    ]);
    expect(droppedSeconds).toBe(0);
  });

  it('keeps the NEWEST ranges within the budget and drops older ones whole', () => {
    const { accepted, droppedSeconds } = acceptPlayedRanges(
      [
        { from: 0, to: 30 },
        { from: 30, to: 60 },
        { from: 60, to: 90 },
      ],
      100,
      65,
    );
    expect(accepted).toEqual([
      { from: 30, to: 60 },
      { from: 60, to: 90 },
    ]);
    expect(droppedSeconds).toBe(30);
  });

  it('stops at the first range that does not fit (a seek to the end never counts)', () => {
    const { accepted } = acceptPlayedRanges(
      [
        { from: 0, to: 5 },
        { from: 5, to: 3600 },
        { from: 3590, to: 3600 },
      ],
      3600,
      20,
    );
    expect(accepted).toEqual([{ from: 3590, to: 3600 }]);
  });

  it('clamps to the duration and drops ranges beyond it', () => {
    const { accepted, droppedSeconds } = acceptPlayedRanges(
      [
        { from: 95, to: 120 },
        { from: 200, to: 210 },
      ],
      100,
      60,
    );
    expect(accepted).toEqual([{ from: 95, to: 100 }]);
    expect(droppedSeconds).toBe(30);
  });
});

describe('bucket spans', () => {
  it('maps [from, to) to buckets floor(from/5) .. floor((to-1)/5)', () => {
    expect(bucketSpansOf([{ from: 0, to: 5 }], 5)).toEqual([{ first: 0, last: 0 }]);
    expect(bucketSpansOf([{ from: 4, to: 6 }], 5)).toEqual([{ first: 0, last: 1 }]);
    expect(bucketSpansOf([{ from: 5, to: 10 }], 5)).toEqual([{ first: 1, last: 1 }]);
  });

  it('sorts and merges overlapping and adjacent spans', () => {
    expect(
      bucketSpansOf(
        [
          { from: 50, to: 60 },
          { from: 0, to: 10 },
          { from: 10, to: 15 },
          { from: 55, to: 70 },
        ],
        5,
      ),
    ).toEqual([
      { first: 0, last: 2 },
      { first: 10, last: 13 },
    ]);
  });

  it('counts buckets as ceil(duration / 5)', () => {
    expect(bucketCountOf(1, 5)).toBe(1);
    expect(bucketCountOf(100, 5)).toBe(20);
    expect(bucketCountOf(101, 5)).toBe(21);
    expect(() => bucketCountOf(0, 5)).toThrow(RangeError);
  });
});

describe('CoverageBitmap', () => {
  it('is MSB-first like Redis SETBIT and the DB varbit (@udemy/db coverage.ts)', () => {
    const bitmap = CoverageBitmap.empty(20).withSpans([
      { first: 0, last: 0 },
      { first: 9, last: 10 },
    ]);
    const bytes = bitmap.toBytes();
    expect(coverageHexLiteral(bytes)).toBe('x806000');
    expect(countCoveredBuckets(bytes, 20)).toBe(3);
    expect(bitmap.coveredBuckets()).toBe(3);
    const roundTrip = coverageTextToBytes('10000000011000000000');
    expect([...roundTrip]).toEqual([...bytes]);
  });

  it('never sets bits at or beyond bucketCount, and drops them on load', () => {
    const bitmap = CoverageBitmap.empty(3).withSpans([{ first: 0, last: 100 }]);
    expect(bitmap.coveredBuckets()).toBe(3);
    expect([...bitmap.toBytes()]).toEqual([0b1110_0000]);
    const loaded = CoverageBitmap.fromBytes(new Uint8Array([0xff, 0xff]), 3);
    expect([...loaded.toBytes()]).toEqual([0b1110_0000]);
  });

  it('is immutable: withSpans returns a new bitmap', () => {
    const empty = CoverageBitmap.empty(8);
    const one = empty.withSpans([{ first: 2, last: 2 }]);
    expect(empty.coveredBuckets()).toBe(0);
    expect(one.has(2)).toBe(true);
  });
});

describe('video completion (D4 / P5-D2, integers)', () => {
  it('completes at exactly 90 % of the buckets', () => {
    expect(meetsVideoCompletion(17, 20, 90)).toBe(false);
    expect(meetsVideoCompletion(18, 20, 90)).toBe(true);
    expect(meetsVideoCompletion(19, 21, 90)).toBe(true); // 90.47 %
    expect(meetsVideoCompletion(18, 21, 90)).toBe(false); // 85.7 %
    expect(meetsVideoCompletion(0, 0, 90)).toBe(false);
  });

  it('reports a floored coverage percentage', () => {
    expect(coveragePctOf(1, 3)).toBe(33);
    expect(coveragePctOf(20, 20)).toBe(100);
    expect(coveragePctOf(0, 0)).toBe(0);
  });
});

describe('completion policy (D4, P5-D3)', () => {
  it('allows ARTICLE_READ / RESOURCE_OPENED / MANUAL only on their types', () => {
    expect(() => assertClientCompletionAllowed('ARTICLE', 'ARTICLE_READ')).not.toThrow();
    expect(() => assertClientCompletionAllowed('ARTICLE', 'MANUAL')).not.toThrow();
    expect(() => assertClientCompletionAllowed('RESOURCE', 'RESOURCE_OPENED')).not.toThrow();
    expect(() => assertClientCompletionAllowed('RESOURCE', 'MANUAL')).not.toThrow();
    expect(() => assertClientCompletionAllowed('ARTICLE', 'RESOURCE_OPENED')).toThrow(
      CompletionNotAllowed,
    );
  });

  it('refuses manual completion of VIDEO and QUIZ (422 completion_not_allowed)', () => {
    for (const type of ['VIDEO', 'QUIZ'] as const) {
      for (const cause of ['MANUAL', 'ARTICLE_READ', 'RESOURCE_OPENED'] as const) {
        expect(() => assertClientCompletionAllowed(type, cause)).toThrow(CompletionNotAllowed);
      }
    }
  });

  it('treats a mismatching server cause as a bug', () => {
    expect(() => assertServerCompletionAllowed('VIDEO', 'VIDEO_WATCHED')).not.toThrow();
    expect(() => assertServerCompletionAllowed('ARTICLE', 'VIDEO_WATCHED')).toThrow(RangeError);
  });

  it('computes % over completed ∩ live ids (removed lectures stop counting)', () => {
    expect(courseProgressOf(new Set(['a', 'b', 'gone']), ['a', 'b', 'c'])).toEqual({
      completed: 2,
      total: 3,
      pct: 66,
    });
    expect(courseProgressOf(new Set(), [])).toEqual({ completed: 0, total: 0, pct: 0 });
  });
});
