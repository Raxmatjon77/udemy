import { describe, expect, it } from 'vitest';
import { FfmpegProgressParser, progressPercent } from './progress';

const block = (lines: string[]): string[] => lines;

describe('FfmpegProgressParser', () => {
  it('emits one snapshot per block, using out_time_us', () => {
    const parser = new FfmpegProgressParser();
    const lines = block([
      'frame=150',
      'fps=85.37',
      'stream_0_0_q=23.0',
      'bitrate=N/A',
      'total_size=N/A',
      'out_time_us=4933333',
      'out_time_ms=4933333',
      'out_time=00:00:04.933333',
      'dup_frames=0',
      'drop_frames=0',
      'speed=2.81x',
    ]);
    for (const line of lines) expect(parser.push(line)).toBeNull();
    expect(parser.push('progress=continue')).toEqual({
      outTimeUs: 4_933_333,
      speed: 2.81,
      done: false,
    });
    expect(parser.push('progress=end')).toEqual({ outTimeUs: 4_933_333, speed: null, done: true });
  });

  it('falls back to out_time_ms (microseconds) and then to out_time', () => {
    const parser = new FfmpegProgressParser();
    parser.push('out_time_ms=1500000');
    expect(parser.push('progress=continue')?.outTimeUs).toBe(1_500_000);
    parser.push('out_time=00:01:02.500000');
    expect(parser.push('progress=continue')?.outTimeUs).toBe(62_500_000);
  });

  it('ignores N/A, negative and garbage values and never goes backwards', () => {
    const parser = new FfmpegProgressParser();
    parser.push('out_time_us=N/A');
    parser.push('out_time=-577014:32:22.775808');
    expect(parser.push('progress=continue')?.outTimeUs).toBeNull();
    parser.push('out_time_us=3000000');
    parser.push('progress=continue');
    parser.push('out_time_us=2000000');
    expect(parser.push('progress=continue')?.outTimeUs).toBe(3_000_000);
    expect(parser.push('no equals sign')).toBeNull();
    expect(parser.push('=value')).toBeNull();
  });
});

describe('progressPercent', () => {
  it('maps microseconds against the duration, clamped to 0..99', () => {
    expect(progressPercent(2_500_000, 5_000)).toBe(50);
    expect(progressPercent(5_000_000, 5_000)).toBe(99);
    expect(progressPercent(9_000_000, 5_000)).toBe(99);
    expect(progressPercent(null, 5_000)).toBe(0);
    expect(progressPercent(1_000, 0)).toBe(0);
  });
});
