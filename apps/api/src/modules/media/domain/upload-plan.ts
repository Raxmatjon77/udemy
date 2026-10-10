import {
  assertValidPartPlan,
  checkUploadedParts,
  type PartCheck,
  type PartPlan,
  partRange,
  planParts,
  type UploadedPartSize,
} from '@udemy/storage';
import { InvalidMediaField } from './media.errors';

export type { PartPlan };

/**
 * The server-chosen part plan of a new upload (design §4, D10):
 * `partSize = max(8 MiB, ceilMiB(size / 1000))`, so at most ~1000 parts.
 *
 * `exactSinglePart: false` keeps a small (single-part) upload at the planned 8 MiB part size
 * instead of shrinking it to the object size, so the stored row satisfies the
 * `assets_part_size_bytes_ck` CHECK (`part_size_bytes >= 5 MiB`). The signed Content-Length is
 * still exact: `partRange` clips the last (here: only) part to `sizeBytes`.
 */
export function planUpload(sizeBytes: number): PartPlan {
  return planParts(sizeBytes, { exactSinglePart: false });
}

/** The persisted plan columns of an asset. */
export interface StoredPlan {
  readonly declaredSizeBytes: number;
  readonly partSizeBytes: number;
  readonly partCount: number;
}

/** Rebuilds (and re-validates) the plan from the `media.assets` row before signing from it. */
export function planOf(stored: StoredPlan): PartPlan {
  const plan: PartPlan = {
    sizeBytes: stored.declaredSizeBytes,
    partSize: stored.partSizeBytes,
    partCount: stored.partCount,
  };
  assertValidPartPlan(plan);
  return plan;
}

/**
 * Part numbers a client may request URLs for: each within 1..partCount (the request schema
 * already bounds the count and uniqueness).
 *
 * @throws InvalidMediaField (422 `validation_failed`) naming the first offending entry
 */
export function assertPartNumbers(plan: PartPlan, partNumbers: readonly number[]): void {
  partNumbers.forEach((n, index) => {
    if (!Number.isInteger(n) || n < 1 || n > plan.partCount) {
      throw new InvalidMediaField({
        path: `partNumbers.${index}`,
        message: `Part ${n} is outside 1..${plan.partCount}.`,
      });
    }
  });
}

/** The exact `Content-Length` signed into the URL of part `n`. */
export function partContentLength(plan: PartPlan, partNumber: number): number {
  return partRange(plan, partNumber).size;
}

/**
 * Verdict on the parts S3 reports (`ListParts`, never client ETags):
 * - `complete`: exactly 1..partCount with the planned sizes;
 * - `incomplete`: some planned parts are missing, the rest is fine (409, retry after uploading);
 * - `size-mismatch`: a part has the wrong size or a number outside the plan. With signed
 *   Content-Length this cannot happen through our URLs, so it is treated as final (422, FAILED).
 */
export type PartVerdict =
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly missingParts: readonly number[] }
  | { readonly kind: 'size-mismatch'; readonly check: PartCheck };

export function judgeUploadedParts(
  plan: PartPlan,
  parts: readonly UploadedPartSize[],
): PartVerdict {
  const check = checkUploadedParts(plan, parts);
  if (check.ok) return { kind: 'complete' };
  if (check.wrongSize.length > 0 || check.unexpected.length > 0) {
    return { kind: 'size-mismatch', check };
  }
  return { kind: 'incomplete', missingParts: check.missing };
}
