import { spawn } from 'node:child_process';

/**
 * Runs an external program (ffmpeg/ffprobe) without a shell: the argument vector goes straight to
 * execve, so nothing in it is ever interpreted. The child gets a minimal environment (no
 * DATABASE_URL / S3 credentials), no stdin, and is killed with SIGTERM, then SIGKILL after a grace
 * period, on timeout, stall, output overflow or abort.
 */

export type ProcessFailureKind = 'spawn' | 'exit' | 'timeout' | 'stalled' | 'output_limit';

export class ProcessError extends Error {
  constructor(
    readonly kind: ProcessFailureKind,
    message: string,
    readonly details: {
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      /** The last bytes of stderr (internal diagnostics only, never user-visible). */
      readonly stderrTail: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = 'ProcessError';
  }
}

export interface RunProcessOptions {
  /** Aborting kills the child; the promise rejects with `signal.reason`. */
  readonly signal?: AbortSignal;
  /** Wall-clock limit (SIGTERM then SIGKILL, rejects with kind `timeout`). */
  readonly timeoutMs?: number;
  /**
   * Kill when `onStdoutLine` has not reported progress (returned true) for this long. The clock
   * starts at spawn.
   */
  readonly stallTimeoutMs?: number;
  /** SIGTERM -> SIGKILL delay. Default 5 s. */
  readonly killGraceMs?: number;
  /** stdout kept in memory (e.g. ffprobe JSON). Exceeding it kills the child. Default 0 (discard). */
  readonly maxStdoutBytes?: number;
  /** stderr bytes kept (the tail). Default 8 KiB. */
  readonly stderrTailBytes?: number;
  /** Called for every complete stdout line; return true when it reports forward progress. */
  readonly onStdoutLine?: (line: string) => boolean | void;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderrTail: string;
}

export const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;

/** The child's whole environment: enough to resolve a bare program name, nothing secret. */
export function childEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    // ffmpeg colours its log output on a TTY only, but be explicit: stderr is stored as text.
    AV_LOG_FORCE_NOCOLOR: '1',
  };
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<ProcessResult>((resolve, reject) => {
    const maxStdout = options.maxStdoutBytes ?? 0;
    const stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let lineBuffer = '';
    let stderrTail = '';
    let failure: { kind: ProcessFailureKind; message: string } | { abort: unknown } | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(command, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment(),
      windowsHide: true,
    });

    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, killGraceMs);
      killTimer.unref();
    };
    const failWith = (next: NonNullable<typeof failure>): void => {
      failure ??= next;
      kill();
    };

    const wallTimer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => failWith({ kind: 'timeout', message: `timed out after ${options.timeoutMs} ms` }),
            options.timeoutMs,
          );
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = (): void => {
      if (options.stallTimeoutMs === undefined) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () =>
          failWith({
            kind: 'stalled',
            message: `no progress for ${options.stallTimeoutMs} ms`,
          }),
        options.stallTimeoutMs,
      );
    };
    armStall();

    const onAbort = (): void => failWith({ abort: signal?.reason });
    signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string): void => {
      if (options.onStdoutLine?.(line) === true) armStall();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (maxStdout > 0) {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdout) {
          failWith({ kind: 'output_limit', message: `stdout exceeded ${maxStdout} bytes` });
          return;
        }
        stdoutChunks.push(chunk);
      }
      if (options.onStdoutLine !== undefined) {
        lineBuffer += chunk.toString('utf8');
        let newline = lineBuffer.indexOf('\n');
        while (newline !== -1) {
          handleLine(lineBuffer.slice(0, newline).replace(/\r$/, ''));
          lineBuffer = lineBuffer.slice(newline + 1);
          newline = lineBuffer.indexOf('\n');
        }
        // A line can never legitimately be this long; drop it rather than buffer without bound.
        if (lineBuffer.length > 64 * 1024) lineBuffer = '';
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-stderrTailBytes);
    });

    const cleanup = (): void => {
      clearTimeout(wallTimer);
      clearTimeout(stallTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ProcessError('spawn', `cannot run ${command}: ${error.code ?? error.message}`, {
          exitCode: null,
          signal: null,
          stderrTail,
          cause: error,
        }),
      );
    });

    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (lineBuffer.length > 0) handleLine(lineBuffer);
      const details = { exitCode, signal: exitSignal, stderrTail };
      if (failure !== undefined) {
        if ('abort' in failure) {
          reject(failure.abort);
          return;
        }
        reject(new ProcessError(failure.kind, `${command} ${failure.message}`, details));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new ProcessError(
            'exit',
            `${command} exited with ${exitCode === null ? `signal ${String(exitSignal)}` : `code ${exitCode}`}`,
            details,
          ),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderrTail });
    });
  });
}
