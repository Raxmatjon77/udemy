import { StorageUsageError } from './errors';

/**
 * Server-side multipart planning (design §4 "Part plan", D10). The server alone decides part
 * sizes; each part URL signs exactly `partRange(plan, n).size` as Content-Length, and
 * `checkUploadedParts` verifies the result from `ListParts` before completing.
 */

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;
export const TiB = 1024 * GiB;

/** S3 limits (also MinIO's). */
export const S3_MIN_PART_SIZE = 5 * MiB;
export const S3_MAX_PART_SIZE = 5 * GiB;
export const S3_MAX_PARTS = 10_000;
export const S3_MAX_OBJECT_SIZE = 5 * TiB;

/** Design default: `partSize = max(8 MiB, ceilMiB(size / 1000))`, i.e. about 1000 parts at most. */
export const DEFAULT_MIN_PART_SIZE = 8 * MiB;
export const DEFAULT_TARGET_MAX_PARTS = 1000;

export interface PartPlan {
  /** Declared total size in bytes (> 0). */
  readonly sizeBytes: number;
  /** Size of every part except possibly the last one. */
  readonly partSize: number;
  /** 1..10 000. */
  readonly partCount: number;
}

export interface PartRange {
  /** 1-based, as in S3. */
  readonly partNumber: number;
  /** First byte offset (inclusive). */
  readonly start: number;
  /** Last byte offset + 1 (exclusive), so `file.slice(start, end)` is the part. */
  readonly end: number;
  /** `end - start`: the exact Content-Length to sign. */
  readonly size: number;
}

export interface PlanPartsOptions {
  /** Lower bound on the part size. Default 8 MiB; must be within [5 MiB, 5 GiB]. */
  minPartSize?: number;
  /** Part count the plan aims to stay under. Default 1000; must be within [1, 10 000]. */
  targetMaxParts?: number;
  /**
   * What `partSize` a SINGLE-part plan reports when the object is smaller than the planned part
   * size. Default `true` (unchanged behaviour): `partSize` shrinks to `sizeBytes`.
   *
   * `false` keeps `partSize` at the planned size (>= `minPartSize`, so >= 5 MiB). The plan is
   * still valid and the signed Content-Length is still exact, because `partRange` clips the last
   * (here: only) part to the object (`partRange(plan, 1).size === sizeBytes`). Use it when the
   * plan is persisted next to a CHECK such as `media.assets.assets_part_size_bytes_ck`
   * (`part_size_bytes >= 5 MiB`); the stored row rebuilds into the same plan. Multi-part plans
   * are identical either way.
   */
  exactSinglePart?: boolean;
}

function assertSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new StorageUsageError(`sizeBytes must be a positive safe integer (got ${sizeBytes})`);
  }
  if (sizeBytes > S3_MAX_OBJECT_SIZE) {
    throw new StorageUsageError(`sizeBytes ${sizeBytes} exceeds the S3 object limit (5 TiB)`);
  }
}

/** Plans the parts for an upload of `sizeBytes`. */
export function planParts(sizeBytes: number, options: PlanPartsOptions = {}): PartPlan {
  assertSize(sizeBytes);
  const minPartSize = options.minPartSize ?? DEFAULT_MIN_PART_SIZE;
  const targetMaxParts = options.targetMaxParts ?? DEFAULT_TARGET_MAX_PARTS;
  if (
    !Number.isSafeInteger(minPartSize) ||
    minPartSize < S3_MIN_PART_SIZE ||
    minPartSize > S3_MAX_PART_SIZE
  ) {
    throw new StorageUsageError('minPartSize must be an integer within [5 MiB, 5 GiB]');
  }
  if (
    !Number.isSafeInteger(targetMaxParts) ||
    targetMaxParts < 1 ||
    targetMaxParts > S3_MAX_PARTS
  ) {
    throw new StorageUsageError('targetMaxParts must be an integer within [1, 10000]');
  }
  const byCount = Math.ceil(sizeBytes / targetMaxParts / MiB) * MiB;
  let partSize = Math.min(Math.max(minPartSize, byCount), S3_MAX_PART_SIZE);
  // By default never report a part larger than the object. Either way a single-part upload
  // signs exactly sizeBytes (partRange clips the last part).
  if (partSize > sizeBytes && (options.exactSinglePart ?? true)) partSize = sizeBytes;
  const partCount = Math.ceil(sizeBytes / partSize);
  const plan: PartPlan = { sizeBytes, partSize, partCount };
  assertValidPartPlan(plan);
  return plan;
}

/**
 * Validates a plan, e.g. one rebuilt from the `media.assets` row (`declared_size_bytes`,
 * `part_size_bytes`, `part_count`), before signing URLs from it.
 */
export function assertValidPartPlan(plan: PartPlan): void {
  assertSize(plan.sizeBytes);
  const { sizeBytes, partSize, partCount } = plan;
  if (!Number.isSafeInteger(partSize) || partSize <= 0 || partSize > S3_MAX_PART_SIZE) {
    throw new StorageUsageError(`partSize ${partSize} is outside (0, 5 GiB]`);
  }
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > S3_MAX_PARTS) {
    throw new StorageUsageError(`partCount ${partCount} is outside [1, 10000]`);
  }
  if (partCount !== Math.ceil(sizeBytes / partSize)) {
    throw new StorageUsageError(
      `partCount ${partCount} does not match ceil(${sizeBytes} / ${partSize})`,
    );
  }
  // Every part but the last must be >= 5 MiB, or CompleteMultipartUpload fails (EntityTooSmall).
  if (partCount > 1 && partSize < S3_MIN_PART_SIZE) {
    throw new StorageUsageError(`partSize ${partSize} is below the S3 minimum of 5 MiB`);
  }
}

/** The exact byte range and size of one part. */
export function partRange(plan: PartPlan, partNumber: number): PartRange {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount) {
    throw new StorageUsageError(`partNumber ${partNumber} is outside [1, ${plan.partCount}]`);
  }
  const start = (partNumber - 1) * plan.partSize;
  const end = Math.min(start + plan.partSize, plan.sizeBytes);
  return { partNumber, start, end, size: end - start };
}

/** All part ranges, in order. */
export function plannedParts(plan: PartPlan): PartRange[] {
  assertValidPartPlan(plan);
  return Array.from({ length: plan.partCount }, (_, i) => partRange(plan, i + 1));
}

export interface UploadedPartSize {
  readonly partNumber: number;
  readonly size: number;
}

export interface PartCheck {
  /** True when parts 1..partCount are all present with the planned sizes and nothing else. */
  readonly ok: boolean;
  /** Planned part numbers not uploaded yet (`upload_incomplete`). */
  readonly missing: number[];
  /** Uploaded with a size other than planned (`upload_size_mismatch`). */
  readonly wrongSize: { partNumber: number; expected: number; actual: number }[];
  /** Part numbers outside 1..partCount. */
  readonly unexpected: number[];
  /** Sum of the sizes of the correctly sized planned parts (resume progress). */
  readonly uploadedBytes: number;
}

/**
 * Compares the parts S3 reports (`ObjectStorage.listParts`) with the plan. This is the
 * defence-in-depth check behind the signed Content-Length (design §9): even if a part URL were
 * signed without it, a wrongly sized part can never be completed.
 */
export function checkUploadedParts(plan: PartPlan, parts: readonly UploadedPartSize[]): PartCheck {
  assertValidPartPlan(plan);
  const seen = new Map<number, number>();
  const unexpected: number[] = [];
  for (const part of parts) {
    if (part.partNumber < 1 || part.partNumber > plan.partCount) unexpected.push(part.partNumber);
    else seen.set(part.partNumber, part.size);
  }
  const missing: number[] = [];
  const wrongSize: { partNumber: number; expected: number; actual: number }[] = [];
  let uploadedBytes = 0;
  for (let n = 1; n <= plan.partCount; n++) {
    const actual = seen.get(n);
    if (actual === undefined) {
      missing.push(n);
      continue;
    }
    const expected = partRange(plan, n).size;
    if (actual === expected) uploadedBytes += actual;
    else wrongSize.push({ partNumber: n, expected, actual });
  }
  return {
    ok: missing.length === 0 && wrongSize.length === 0 && unexpected.length === 0,
    missing,
    wrongSize,
    unexpected,
    uploadedBytes,
  };
}
