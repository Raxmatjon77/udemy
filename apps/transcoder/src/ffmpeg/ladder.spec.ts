import { describe, expect, it } from 'vitest';
import { fitInto, renditionCodecs, selectLadder } from './ladder';

const dims = (size: { width: number; height: number }): string => `${size.width}x${size.height}`;
const summary = (w: number, h: number, max: number): string[] =>
  selectLadder({ width: w, height: h }, max).map((r) => `${r.name}=${dims(r)}`);

describe('selectLadder', () => {
  it('1080p landscape source: 360/720/1080 under a 1080 cap', () => {
    expect(summary(1920, 1080, 1080)).toEqual(['360p=640x360', '720p=1280x720', '1080p=1920x1080']);
  });

  it('TRANSCODER_MAX_HEIGHT caps the ladder (dev: 720)', () => {
    expect(summary(1920, 1080, 720)).toEqual(['360p=640x360', '720p=1280x720']);
    expect(summary(3840, 2160, 1080)).toEqual(['360p=640x360', '720p=1280x720', '1080p=1920x1080']);
  });

  it('never upscales: a 720p source stops at 720p', () => {
    expect(summary(1280, 720, 1080)).toEqual(['360p=640x360', '720p=1280x720']);
  });

  it('a source between rungs keeps the rungs below it', () => {
    expect(summary(960, 540, 1080)).toEqual(['360p=640x360']);
  });

  it('rungs follow the SHORT side, so portrait gets the same ladder transposed', () => {
    expect(summary(1080, 1920, 1080)).toEqual(['360p=360x640', '720p=720x1280', '1080p=1080x1920']);
    expect(summary(540, 960, 720)).toEqual(['360p=360x640']);
  });

  it('keeps the aspect ratio inside each box (4:3, 2.39:1), sides even', () => {
    expect(summary(1440, 1080, 1080)).toEqual(['360p=480x360', '720p=960x720', '1080p=1440x1080']);
    expect(summary(1920, 804, 1080)).toEqual(['360p=640x268', '720p=1280x536']);
  });

  it('a source below 360p gets one src{short}p rendition at its own (even) size', () => {
    expect(summary(320, 240, 1080)).toEqual(['src240p=320x240']);
    expect(summary(321, 181, 1080)).toEqual(['src182p=322x182']);
  });

  it('carries the H.264 profile/level and bitrates of each rung', () => {
    const [low, mid, high] = selectLadder({ width: 1920, height: 1080 }, 1080);
    expect(low).toMatchObject({
      profile: 'main',
      level: '3.0',
      videoKbps: 800,
      videoCodecs: 'avc1.4d401e',
    });
    expect(mid).toMatchObject({
      profile: 'high',
      level: '3.1',
      videoKbps: 2800,
      videoCodecs: 'avc1.64001f',
    });
    expect(high).toMatchObject({
      profile: 'high',
      level: '4.0',
      videoKbps: 5000,
      videoCodecs: 'avc1.640028',
    });
  });

  it('rejects sources too small to name and invalid sizes', () => {
    expect(() => selectLadder({ width: 160, height: 90 }, 1080)).toThrow(/short side 90/);
    expect(() => selectLadder({ width: 0, height: 720 }, 1080)).toThrow(RangeError);
  });

  it('CODECS adds AAC-LC only when the source has audio', () => {
    const [rung] = selectLadder({ width: 640, height: 360 }, 1080);
    expect(renditionCodecs(rung!, true)).toBe('avc1.4d401e,mp4a.40.2');
    expect(renditionCodecs(rung!, false)).toBe('avc1.4d401e');
  });
});

describe('fitInto', () => {
  it('fits without upscaling and rounds to even sides', () => {
    expect(fitInto({ width: 1000, height: 1000 }, { width: 640, height: 360 })).toEqual({
      width: 360,
      height: 360,
    });
    expect(fitInto({ width: 300, height: 200 }, { width: 640, height: 360 })).toEqual({
      width: 300,
      height: 200,
    });
    expect(fitInto({ width: 1279, height: 719 }, { width: 1280, height: 720 })).toEqual({
      width: 1280,
      height: 720,
    });
  });
});
