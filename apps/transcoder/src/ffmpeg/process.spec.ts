import { describe, expect, it } from 'vitest';
import { childEnvironment, ProcessError, runProcess } from './process';

/** The Node binary stands in for ffmpeg: scripted children exercise every kill path. */
const NODE = process.execPath;
const script = (code: string): string[] => ['-e', code];

describe('runProcess', () => {
  it('collects stdout and passes a minimal environment (no secrets)', async () => {
    process.env.TRANSCODER_TEST_SECRET = 'leak-me';
    try {
      const { stdout } = await runProcess(
        NODE,
        script('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'),
        { maxStdoutBytes: 4096 },
      );
      const keys = JSON.parse(stdout) as string[];
      expect(keys).not.toContain('TRANSCODER_TEST_SECRET');
      expect(keys).not.toContain('DATABASE_URL');
      expect(Object.keys(childEnvironment()).sort()).toEqual(['AV_LOG_FORCE_NOCOLOR', 'PATH']);
    } finally {
      delete process.env.TRANSCODER_TEST_SECRET;
    }
  });

  it('never runs a shell: metacharacters are plain argv', async () => {
    const { stdout } = await runProcess(
      NODE,
      ['-e', 'process.stdout.write(process.argv[1])', '$(touch /tmp/pwned); `id` | cat'],
      { maxStdoutBytes: 1024 },
    );
    expect(stdout).toBe('$(touch /tmp/pwned); `id` | cat');
  });

  it('rejects with kind exit and keeps the stderr tail', async () => {
    const error = await runProcess(
      NODE,
      script('process.stderr.write("bad input\\n"); process.exit(3)'),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error).toMatchObject({
      kind: 'exit',
      details: { exitCode: 3, stderrTail: 'bad input\n' },
    });
  });

  it('rejects with kind spawn for a missing binary', async () => {
    await expect(runProcess('/nonexistent/ffmpeg', [])).rejects.toMatchObject({ kind: 'spawn' });
  });

  it('kills on the wall-clock timeout', async () => {
    const started = Date.now();
    await expect(
      runProcess(NODE, script('setInterval(() => {}, 1000)'), { timeoutMs: 200 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const error = await runProcess(
      NODE,
      script('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'),
      { timeoutMs: 300, killGraceMs: 200 },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout', details: { signal: 'SIGKILL' } });
  });

  it('kills a child that stops reporting progress', async () => {
    const error = await runProcess(
      NODE,
      script(
        'let i = 0; const t = setInterval(() => { console.log("out_time_us=" + (i < 3 ? ++i : i)); }, 50)',
      ),
      {
        stallTimeoutMs: 400,
        timeoutMs: 10_000,
        onStdoutLine: (() => {
          let last = '';
          return (line: string) => {
            const advanced = line !== last;
            last = line;
            return advanced;
          };
        })(),
      },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'stalled' });
  });

  it('kills on stdout overflow', async () => {
    await expect(
      runProcess(NODE, script('process.stdout.write("x".repeat(100000))'), {
        maxStdoutBytes: 1000,
      }),
    ).rejects.toMatchObject({ kind: 'output_limit' });
  });

  it('abort kills the child and rejects with the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('shutting down');
    const lines: string[] = [];
    const run = runProcess(NODE, script('setInterval(() => console.log("tick"), 20)'), {
      signal: controller.signal,
      onStdoutLine: (line) => {
        lines.push(line);
        if (lines.length === 2) controller.abort(reason);
      },
    });
    await expect(run).rejects.toBe(reason);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects at once when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await expect(runProcess(NODE, ['-v'], { signal: controller.signal })).rejects.toThrow('early');
  });
});
