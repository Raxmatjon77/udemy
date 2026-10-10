import { describe, expect, it } from 'vitest';
import { StorageUsageError } from './errors';
import {
  assertValidPartPlan,
  checkUploadedParts,
  GiB,
  MiB,
  partRange,
  plannedParts,
  planParts,
  S3_MAX_OBJECT_SIZE,
  S3_MAX_PART_SIZE,
  S3_MAX_PARTS,
  S3_MIN_PART_SIZE,
  TiB,
} from './part-plan';

describe('planParts', () => {
  it.each([
    // sizeBytes, partSize, partCount
    [1, 1, 1],
    [5 * MiB, 5 * MiB, 1],
    [8 * MiB, 8 * MiB, 1],
    [8 * MiB + 1, 8 * MiB, 2],
    [100 * MiB, 8 * MiB, 13],
    [1 * GiB, 8 * MiB, 128],
    [4 * GiB, 8 * MiB, 512], // MEDIA_MAX_VIDEO_BYTES
    [8000 * MiB, 8 * MiB, 1000], // the largest size that still uses the 8 MiB floor
    [8000 * MiB + 1, 9 * MiB, 889], // ceilMiB(size / 1000)
    [100 * GiB, 103 * MiB, 995],
  ])('%d bytes -> %d-byte parts x %d', (size, partSize, partCount) => {
    expect(planParts(size)).toEqual({ sizeBytes: size, partSize, partCount });
  });

  it('follows the design formula max(8 MiB, ceilMiB(size / 1000))', () => {
    for (const size of [12_345_678, 3 * GiB + 17, 77 * GiB + 3, 1 * TiB]) {
      const expected = Math.max(8 * MiB, Math.ceil(size / 1000 / MiB) * MiB);
      expect(planParts(size).partSize).toBe(Math.min(expected, size));
    }
  });

  it('caps the part size at 5 GiB and stays within 10 000 parts at the 5 TiB limit', () => {
    const plan = planParts(S3_MAX_OBJECT_SIZE);
    expect(plan.partSize).toBe(S3_MAX_PART_SIZE);
    expect(plan.partCount).toBe(1024);
    expect(plan.partCount).toBeLessThanOrEqual(S3_MAX_PARTS);
  });

  it('honours minPartSize / targetMaxParts and validates them', () => {
    expect(planParts(20 * MiB, { minPartSize: 5 * MiB })).toEqual({
      sizeBytes: 20 * MiB,
      partSize: 5 * MiB,
      partCount: 4,
    });
    expect(planParts(10 * GiB, { minPartSize: 5 * MiB, targetMaxParts: 10_000 }).partSize).toBe(
      5 * MiB,
    );
    expect(() => planParts(10, { minPartSize: 4 * MiB })).toThrow(StorageUsageError);
    expect(() => planParts(10, { targetMaxParts: 10_001 })).toThrow(StorageUsageError);
  });

  it.each([0, -1, 1.5, Number.NaN, S3_MAX_OBJECT_SIZE + 1, 2 ** 53])('rejects size %d', (size) => {
    expect(() => planParts(size)).toThrow(StorageUsageError);
  });

  it('keeps every non-last part >= 5 MiB and every plan valid', () => {
    for (let size = 1; size < 6 * GiB; size = Math.ceil(size * 1.7) + 12_345) {
      const plan = planParts(size);
      expect(() => assertValidPartPlan(plan)).not.toThrow();
      if (plan.partCount > 1) expect(plan.partSize).toBeGreaterThanOrEqual(S3_MIN_PART_SIZE);
    }
  });
});

describe('partRange / plannedParts', () => {
  it('returns contiguous exact byte ranges covering the whole object', () => {
    const plan = planParts(20 * MiB + 3, { minPartSize: 8 * MiB });
    const parts = plannedParts(plan);
    expect(parts).toEqual([
      { partNumber: 1, start: 0, end: 8 * MiB, size: 8 * MiB },
      { partNumber: 2, start: 8 * MiB, end: 16 * MiB, size: 8 * MiB },
      { partNumber: 3, start: 16 * MiB, end: 20 * MiB + 3, size: 4 * MiB + 3 },
    ]);
    expect(parts.reduce((sum, p) => sum + p.size, 0)).toBe(plan.sizeBytes);
  });

  it('has an exactly sized last part when the size is a multiple of the part size', () => {
    const plan = planParts(16 * MiB);
    expect(partRange(plan, 2)).toEqual({
      partNumber: 2,
      start: 8 * MiB,
      end: 16 * MiB,
      size: 8 * MiB,
    });
  });

  it.each([0, 3, 1.5, -1])('rejects part number %d', (n) => {
    expect(() => partRange(planParts(16 * MiB), n)).toThrow(StorageUsageError);
  });
});

describe('assertValidPartPlan (plans rebuilt from the DB row)', () => {
  it.each([
    [{ sizeBytes: 16 * MiB, partSize: 8 * MiB, partCount: 3 }, 'count mismatch'],
    [{ sizeBytes: 10 * MiB, partSize: 1 * MiB, partCount: 10 }, 'part < 5 MiB'],
    [{ sizeBytes: 10, partSize: 0, partCount: 1 }, 'zero part size'],
    [{ sizeBytes: 6 * GiB, partSize: 6 * GiB, partCount: 1 }, 'part > 5 GiB'],
    [{ sizeBytes: 10_001 * 5 * MiB, partSize: 5 * MiB, partCount: 10_001 }, '> 10 000 parts'],
  ])('rejects %o (%s)', (plan) => {
    expect(() => assertValidPartPlan(plan)).toThrow(StorageUsageError);
  });

  it('accepts a single small part', () => {
    expect(() => assertValidPartPlan({ sizeBytes: 10, partSize: 10, partCount: 1 })).not.toThrow();
  });
});

describe('checkUploadedParts', () => {
  const plan = planParts(20 * MiB + 3); // 8 MiB, 8 MiB, 4 MiB + 3

  it('accepts exactly the planned parts in any order', () => {
    const check = checkUploadedParts(plan, [
      { partNumber: 3, size: 4 * MiB + 3 },
      { partNumber: 1, size: 8 * MiB },
      { partNumber: 2, size: 8 * MiB },
    ]);
    expect(check).toEqual({
      ok: true,
      missing: [],
      wrongSize: [],
      unexpected: [],
      uploadedBytes: plan.sizeBytes,
    });
  });

  it('reports missing, wrongly sized and unexpected parts', () => {
    const check = checkUploadedParts(plan, [
      { partNumber: 1, size: 8 * MiB },
      { partNumber: 3, size: 5 * GiB },
      { partNumber: 4, size: 1 },
    ]);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([2]);
    expect(check.wrongSize).toEqual([{ partNumber: 3, expected: 4 * MiB + 3, actual: 5 * GiB }]);
    expect(check.unexpected).toEqual([4]);
    expect(check.uploadedBytes).toBe(8 * MiB);
  });

  it('reports everything missing for an empty listing', () => {
    expect(checkUploadedParts(plan, []).missing).toEqual([1, 2, 3]);
  });
});
