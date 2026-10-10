import { describe, expect, it } from 'vitest';
import type { ProbeResult, ProbedVideoStream } from '../ffmpeg/probe';
import { TranscodeFailure } from './failure';
import { checkImageHeader, checkImageProbe, checkVideoProbe } from './probe-checks';

const stream = (over: Partial<ProbedVideoStream> = {}): ProbedVideoStream => ({
  index: 0,
  codecName: 'h264',
  width: 1280,
  height: 720,
  rotation: 0,
  sampleAspectRatio: { num: 1, den: 1 },
  frameRate: 30,
  attachedPic: false,
  ...over,
});

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 5,
  video: [stream()],
  audio: [{ index: 1, codecName: 'aac', channels: 2, sampleRate: 48000 }],
  ...over,
});

const LIMITS = { maxSourceSeconds: 14_400 };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof TranscodeFailure) return error.code;
    throw error;
  }
  return 'OK';
}

describe('checkVideoProbe', () => {
  it('accepts a normal clip', () => {
    expect(checkVideoProbe(probe(), LIMITS)).toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 5,
      durationMs: 5000,
      display: { width: 1280, height: 720 },
      hasAudio: true,
      capFrameRate: false,
    });
  });

  it('applies rotation and sample aspect ratio to the display size; flags > 30 fps', () => {
    const rotated = checkVideoProbe(
      probe({ video: [stream({ width: 1920, height: 1080, rotation: 90, frameRate: 60 })] }),
      LIMITS,
    );
    expect(rotated.display).toEqual({ width: 1080, height: 1920 });
    expect(rotated.capFrameRate).toBe(true);
    const anamorphic = checkVideoProbe(
      probe({
        video: [stream({ width: 720, height: 576, sampleAspectRatio: { num: 16, den: 11 } })],
      }),
      LIMITS,
    );
    expect(anamorphic.display).toEqual({ width: 1047, height: 576 });
  });

  it('ignores cover art and reports a missing video stream as INVALID_MEDIA', () => {
    expect(
      codeOf(() => checkVideoProbe(probe({ video: [stream({ attachedPic: true })] }), LIMITS)),
    ).toBe('INVALID_MEDIA');
    expect(codeOf(() => checkVideoProbe(probe({ video: [] }), LIMITS))).toBe('INVALID_MEDIA');
  });

  it.each([
    ['disallowed container', probe({ formatName: 'hls' }), 'UNSUPPORTED_MEDIA'],
    ['no frame size', probe({ video: [stream({ width: 0, height: 0 })] }), 'INVALID_MEDIA'],
    ['5K frame', probe({ video: [stream({ width: 5120, height: 2880 })] }), 'TOO_LARGE_DIMENSIONS'],
    [
      'portrait 4K beyond 2160 short side',
      probe({ video: [stream({ width: 2400, height: 4096 })] }),
      'TOO_LARGE_DIMENSIONS',
    ],
    [
      'absurd sample aspect',
      probe({ video: [stream({ sampleAspectRatio: { num: 100, den: 1 } })] }),
      'TOO_LARGE_DIMENSIONS',
    ],
    ['tiny frame', probe({ video: [stream({ width: 96, height: 64 })] }), 'INVALID_MEDIA'],
    ['no duration', probe({ durationSeconds: null }), 'INVALID_MEDIA'],
    ['over the max duration', probe({ durationSeconds: 14_400.5 }), 'TOO_LONG'],
  ])('rejects: %s', (_, input, code) => {
    expect(codeOf(() => checkVideoProbe(input, LIMITS))).toBe(code);
  });

  it('accepts exactly 4096x2160 and portrait 2160x4096', () => {
    expect(
      codeOf(() =>
        checkVideoProbe(probe({ video: [stream({ width: 4096, height: 2160 })] }), LIMITS),
      ),
    ).toBe('OK');
    expect(
      codeOf(() =>
        checkVideoProbe(probe({ video: [stream({ width: 2160, height: 4096 })] }), LIMITS),
      ),
    ).toBe('OK');
  });
});

describe('image checks', () => {
  it('header: 40 MP and 16384 px caps before decode, 16 px minimum', () => {
    expect(checkImageHeader({ width: 1600, height: 1200 })).toEqual({ width: 1600, height: 1200 });
    expect(codeOf(() => checkImageHeader({ width: 7000, height: 6000 }))).toBe(
      'TOO_LARGE_DIMENSIONS',
    );
    expect(codeOf(() => checkImageHeader({ width: 20000, height: 100 }))).toBe(
      'TOO_LARGE_DIMENSIONS',
    );
    expect(codeOf(() => checkImageHeader({ width: 8, height: 8 }))).toBe('INVALID_MEDIA');
    expect(codeOf(() => checkImageHeader(null))).toBe('INVALID_MEDIA');
  });

  it('probe: allowed demuxer, decoded, and the same size as the header', () => {
    const image = probe({
      formatName: 'png_pipe',
      durationSeconds: null,
      audio: [],
      video: [stream({ width: 1600, height: 1200 })],
    });
    expect(checkImageProbe(image, { width: 1600, height: 1200 })).toEqual({
      formatName: 'png_pipe',
      width: 1600,
      height: 1200,
    });
    expect(codeOf(() => checkImageProbe(image, { width: 16, height: 16 }))).toBe('INVALID_MEDIA');
    expect(
      codeOf(() =>
        checkImageProbe({ ...image, formatName: 'image2' }, { width: 1600, height: 1200 }),
      ),
    ).toBe('UNSUPPORTED_MEDIA');
    expect(
      codeOf(() =>
        checkImageProbe(
          { ...image, video: [stream({ width: 0, height: 0 })] },
          { width: 1600, height: 1200 },
        ),
      ),
    ).toBe('INVALID_MEDIA');
  });
});
