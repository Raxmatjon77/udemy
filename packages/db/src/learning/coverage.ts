/**
 * Coverage bitmap encoding (docs/phase-5-schema-design.md §0, §7). Pure TS, no database.
 *
 * Bit i (0-based, left to right, MSB-first in each byte) = 5 s bucket i = Redis SETBIT offset i.
 * - The DB stores `varbit` of exactly `coverageBucketCount(duration)` bits (lecture_progress_coverage_ck).
 * - Writes send the Redis bytes as a hex bit-string literal (`'x' || hex`, cast `::varbit`), always
 *   wrapped in `learning.fit_coverage(..., (duration + 4) / 5)`: Redis SETBIT only grows the value
 *   to the highest set bit, and hex input is a multiple of 8 bits.
 * - Reads come back as '0'/'1' text (node-pg has no varbit parser); `coverageTextToBytes` packs
 *   them for `SET lpc:{u}:{l}` when Redis has to be re-seeded.
 */

/** `LEARNING_PROGRESS_RULES.bucketSeconds`; never change once progress exists. */
export const COVERAGE_BUCKET_SECONDS = 5;
/** `lecture_progress_duration_seconds_ck` upper bound (a day of video = 17280 buckets). */
export const MAX_PROGRESS_DURATION_SECONDS = 86_400;

/** `(duration + 4) / 5` = ceil(duration / 5), the CHECKed bitmap length. */
export function coverageBucketCount(durationSeconds: number): number {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > MAX_PROGRESS_DURATION_SECONDS
  ) {
    throw new RangeError(
      `durationSeconds must be an integer in 1..${MAX_PROGRESS_DURATION_SECONDS}, got ${durationSeconds}`,
    );
  }
  return Math.floor((durationSeconds + COVERAGE_BUCKET_SECONDS - 1) / COVERAGE_BUCKET_SECONDS);
}

/**
 * `x<hex>` bit-string literal of the Redis bytes (bound as a text parameter and cast `::varbit`).
 * An empty bitmap becomes one zero byte, so the literal is never the bare `x` whose meaning PG 18
 * was not probed for (§0 V3); `fit_coverage` pads or truncates to the right length anyway.
 */
export function coverageHexLiteral(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'x00';
  return `x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')}`;
}

/** '0'/'1' text (the DB's varbit output) -> bytes, MSB-first, last byte zero-padded on the right. */
export function coverageTextToBytes(bits: string): Uint8Array {
  if (!/^[01]*$/.test(bits)) throw new RangeError('coverage text must contain only 0 and 1');
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits.charCodeAt(i) === 49) out[i >> 3]! |= 0x80 >> (i & 7);
  }
  return out;
}

/** Number of set bits among the first `bucketCount` bits (what `learning.coverage_bits` counts after fitting). */
export function countCoveredBuckets(bytes: Uint8Array, bucketCount: number): number {
  let n = 0;
  const limit = Math.min(bucketCount, bytes.length * 8);
  for (let i = 0; i < limit; i++) {
    if ((bytes[i >> 3]! & (0x80 >> (i & 7))) !== 0) n++;
  }
  return n;
}
