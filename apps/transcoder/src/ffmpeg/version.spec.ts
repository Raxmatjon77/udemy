import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyToolchain } from './ffmpeg-toolchain.service';
import { assertSupportedVersion, FfmpegVersionError, parseToolVersion } from './version';

describe('parseToolVersion', () => {
  it.each([
    [
      'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers',
      '6.1.1-3ubuntu5',
      6,
    ],
    ['ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers', '8.1.2', 8],
    ['ffmpeg version n7.1 Copyright (c) 2000-2024', 'n7.1', 7],
    ['ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/', '7.0.2-static', 7],
  ])('parses "%s"', (line, version, major) => {
    expect(parseToolVersion('ffmpeg', `${line}\nbuilt with gcc`)).toMatchObject({ version, major });
  });

  it('returns null for git snapshots, date builds and the wrong tool', () => {
    expect(parseToolVersion('ffmpeg', 'ffmpeg version N-112233-gabcdef Copyright')).toBeNull();
    expect(parseToolVersion('ffmpeg', 'ffmpeg version 2024-05-01-git-abc-full_build')).toBeNull();
    expect(parseToolVersion('ffmpeg', 'ffprobe version 6.1 Copyright')).toBeNull();
    expect(parseToolVersion('ffprobe', 'ffprobe version 6.1 Copyright')).toMatchObject({
      major: 6,
    });
  });
});

describe('assertSupportedVersion', () => {
  it('accepts >= 6 and refuses older or unparseable versions with a clear message', () => {
    expect(assertSupportedVersion('ffmpeg', 'ffmpeg', 'ffmpeg version 6.0 Copyright').major).toBe(
      6,
    );
    expect(() =>
      assertSupportedVersion('ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg version 5.1.4 x'),
    ).toThrow(/ffmpeg 5\.1\.4 found at "\/usr\/bin\/ffmpeg"; the transcoder needs ffmpeg >= 6/);
    expect(() =>
      assertSupportedVersion('ffprobe', 'ffprobe', 'ffprobe version N-1-gdead x'),
    ).toThrow(FfmpegVersionError);
  });
});

describe('verifyToolchain (boot check) with stand-in binaries', () => {
  let dir: string;

  const fakeTool = async (name: string, firstLine: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\necho '${firstLine}'\n`);
    await chmod(path, 0o755);
    return path;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'transcoder-version-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes for ffmpeg/ffprobe >= 6', async () => {
    const result = await verifyToolchain({
      ffmpeg: await fakeTool('ffmpeg-ok', 'ffmpeg version 6.1.1 Copyright'),
      ffprobe: await fakeTool('ffprobe-ok', 'ffprobe version 8.1.2 Copyright'),
    });
    expect(result.ffmpeg.major).toBe(6);
    expect(result.ffprobe.major).toBe(8);
  });

  it('fails the boot for ffmpeg 5', async () => {
    await expect(
      verifyToolchain({
        ffmpeg: await fakeTool('ffmpeg-old', 'ffmpeg version 5.1.2 Copyright'),
        ffprobe: await fakeTool('ffprobe-ok2', 'ffprobe version 6.1 Copyright'),
      }),
    ).rejects.toThrow(/ffmpeg 5\.1\.2 found .* needs ffmpeg >= 6/);
  });

  it('fails the boot with a clear message when a binary is missing', async () => {
    await expect(
      verifyToolchain({ ffmpeg: join(dir, 'does-not-exist'), ffprobe: join(dir, 'nope') }),
    ).rejects.toThrow(
      /Cannot run ffmpeg at ".*does-not-exist" \(it was not found or is not executable\)/,
    );
  });
});
