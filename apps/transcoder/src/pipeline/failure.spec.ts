import { MEDIA_FAILURE_CODES } from '@udemy/contracts';
import { StorageNotFoundError, StorageUnavailableError } from '@udemy/storage';
import { describe, expect, it } from 'vitest';
import { ProcessError } from '../ffmpeg/process';
import { classifyFailure, FAILURE_CODES, isRetryable, TranscodeFailure } from './failure';

const processError = (kind: ConstructorParameters<typeof ProcessError>[0]): ProcessError =>
  new ProcessError(kind, `ffmpeg ${kind}`, { exitCode: 1, signal: null, stderrTail: 'boom\n' });

describe('classifyFailure', () => {
  it('every transcoder code is a contract failure code', () => {
    for (const code of FAILURE_CODES) expect(MEDIA_FAILURE_CODES).toContain(code);
  });

  it('keeps the code of a TranscodeFailure', () => {
    expect(classifyFailure(new TranscodeFailure('TOO_LONG', 'duration 5h'))).toEqual({
      code: 'TOO_LONG',
      detail: 'duration 5h',
      forceTerminal: false,
    });
  });

  it.each([
    ['timeout', 'TIMEOUT'],
    ['stalled', 'TIMEOUT'],
    ['exit', 'TRANSCODE_ERROR'],
    ['output_limit', 'TRANSCODE_ERROR'],
    ['spawn', 'INTERNAL'],
  ] as const)('ffmpeg %s -> %s, with the stderr tail as detail', (kind, code) => {
    const failure = classifyFailure(processError(kind));
    expect(failure.code).toBe(code);
    expect(failure.detail).toContain('boom');
  });

  it('S3 outages, disk and unknown errors are INTERNAL (retryable); a vanished source is terminal', () => {
    expect(classifyFailure(new StorageUnavailableError({ operation: 'putObject' }))).toMatchObject({
      code: 'INTERNAL',
      forceTerminal: false,
    });
    expect(classifyFailure(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toMatchObject(
      { code: 'INTERNAL', forceTerminal: false, detail: 'Error ENOSPC: no space' },
    );
    expect(
      classifyFailure(
        new StorageNotFoundError('gone', { operation: 'getObjectStream', s3Code: 'NoSuchKey' }),
      ),
    ).toMatchObject({ code: 'INTERNAL', forceTerminal: true });
  });
});

describe('isRetryable', () => {
  const failure = (code: (typeof FAILURE_CODES)[number], forceTerminal = false) => ({
    code,
    detail: '',
    forceTerminal,
  });

  it('poison codes are never retried', () => {
    for (const code of [
      'INVALID_MEDIA',
      'UNSUPPORTED_MEDIA',
      'TOO_LONG',
      'TOO_LARGE_DIMENSIONS',
    ] as const) {
      expect(isRetryable(failure(code), 1, 3)).toBe(false);
    }
  });

  it('TRANSCODE_ERROR and TIMEOUT are retried once', () => {
    expect(isRetryable(failure('TRANSCODE_ERROR'), 1, 3)).toBe(true);
    expect(isRetryable(failure('TRANSCODE_ERROR'), 2, 3)).toBe(false);
    expect(isRetryable(failure('TIMEOUT'), 1, 3)).toBe(true);
    expect(isRetryable(failure('TIMEOUT'), 2, 3)).toBe(false);
  });

  it('INTERNAL is retried until max attempts; forced-terminal and CRASHED never', () => {
    expect(isRetryable(failure('INTERNAL'), 2, 3)).toBe(true);
    expect(isRetryable(failure('INTERNAL'), 3, 3)).toBe(false);
    expect(isRetryable(failure('INTERNAL', true), 1, 3)).toBe(false);
    expect(isRetryable(failure('CRASHED'), 1, 3)).toBe(false);
    expect(isRetryable(failure('TIMEOUT'), 1, 1)).toBe(false);
  });
});
