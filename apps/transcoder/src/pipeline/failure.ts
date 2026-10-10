import type { MediaFailureCode } from '@udemy/contracts';
import { TRANSCODE_ERROR_CODES, type TranscodeErrorCode } from '@udemy/db';
import { StorageNotFoundError } from '@udemy/storage';
import { ProcessError } from '../ffmpeg/process';

/** Every transcoder failure code is a contract failure code (MediaFailed.failureCode). */
type AssertSubset<T extends MediaFailureCode> = T;
export type FailureCode = AssertSubset<TranscodeErrorCode>;
export const FAILURE_CODES: readonly FailureCode[] = TRANSCODE_ERROR_CODES;

/**
 * Poison: the input itself is unacceptable; retrying cannot help (design §4 failure classes).
 */
export const POISON_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  'INVALID_MEDIA',
  'UNSUPPORTED_MEDIA',
  'TOO_LONG',
  'TOO_LARGE_DIMENSIONS',
]);

/** A classified failure raised by the pipeline. `detail` is internal (never user-visible). */
export class TranscodeFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly detail: string,
    /** Force terminal even when the class would allow a retry (e.g. the source is gone). */
    readonly forceTerminal = false,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${detail}`, options);
    this.name = 'TranscodeFailure';
  }
}

export interface ClassifiedFailure {
  readonly code: FailureCode;
  readonly detail: string;
  readonly forceTerminal: boolean;
}

function describe(error: unknown): string {
  if (error instanceof ProcessError) {
    const tail = error.details.stderrTail.trim();
    return tail === '' ? error.message : `${error.message}: ${tail}`;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string'
      ? `${error.name} ${code}: ${error.message}`
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Maps anything thrown by the pipeline to a failure code:
 *
 * | Thrown                                   | Code            |
 * | ---------------------------------------- | --------------- |
 * | TranscodeFailure                         | its own code    |
 * | ffmpeg timeout / no progress             | TIMEOUT         |
 * | ffmpeg non-zero exit or output overflow  | TRANSCODE_ERROR |
 * | source object missing (NoSuchKey)        | INTERNAL, terminal (it will not come back) |
 * | S3, DB, disk, spawn, anything else       | INTERNAL        |
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof TranscodeFailure) {
    return { code: error.code, detail: error.detail, forceTerminal: error.forceTerminal };
  }
  if (error instanceof ProcessError) {
    switch (error.kind) {
      case 'timeout':
      case 'stalled':
        return { code: 'TIMEOUT', detail: describe(error), forceTerminal: false };
      case 'exit':
      case 'output_limit':
        return { code: 'TRANSCODE_ERROR', detail: describe(error), forceTerminal: false };
      case 'spawn':
        return { code: 'INTERNAL', detail: describe(error), forceTerminal: false };
    }
  }
  if (error instanceof StorageNotFoundError && error.s3Code === 'NoSuchKey') {
    // The source vanished between the HEAD and the read (purge/cleanup race): it will not return.
    return { code: 'INTERNAL', detail: describe(error), forceTerminal: true };
  }
  return { code: 'INTERNAL', detail: describe(error), forceTerminal: false };
}

/**
 * Whether a failure may be retried (the DB still enforces `attempts < max_attempts`):
 * poison never; TRANSCODE_ERROR and TIMEOUT once (only after the first attempt); INTERNAL until
 * `maxAttempts`; CRASHED never (the reaper's terminal code).
 *
 * @param attempts penalised attempts INCLUDING the current one (from the lease)
 */
export function isRetryable(
  failure: ClassifiedFailure,
  attempts: number,
  maxAttempts: number,
): boolean {
  if (failure.forceTerminal || POISON_CODES.has(failure.code) || failure.code === 'CRASHED') {
    return false;
  }
  if (attempts >= maxAttempts) return false;
  if (failure.code === 'TRANSCODE_ERROR' || failure.code === 'TIMEOUT') return attempts < 2;
  return true;
}
