/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react';
import {
  HlsPlayer,
  type HlsPlayerHandle,
  type PlayedRangesReport,
} from '@udemy/ui/components/hls-player';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

/*
 * The real `@udemy/ui` `<HlsPlayer>` (Phase 5 API) in jsdom: jsdom cannot decode media, so the
 * test drives the `<video>` element's state and events like a browser would and checks what the
 * player reports. (Playback itself — hls.js, refreshes, problem codes — is unit-tested in
 * packages/ui.)
 */

function mount() {
  const reports: PlayedRangesReport[] = [];
  const playing: boolean[] = [];
  const onEnded = vi.fn();
  const ref = createRef<HlsPlayerHandle>();
  render(
    <HlsPlayer
      ref={ref}
      src="/api/proxy/catalog/courses/c/lectures/l/hls/master.m3u8"
      title="Welcome"
      startPosition={42}
      onPlayedRanges={(report) => reports.push(report)}
      onPlayingChange={(value) => playing.push(value)}
      onEnded={onEnded}
    />,
  );
  const video = screen.getByLabelText('Welcome') as HTMLVideoElement;
  const media = { currentTime: 0, paused: true, seeking: false, ended: false, duration: 300 };
  for (const key of Object.keys(media) as (keyof typeof media)[]) {
    Object.defineProperty(video, key, {
      configurable: true,
      get: () => media[key],
      set: (value: never) => {
        media[key] = value;
      },
    });
  }
  const fire = (type: string) => act(() => void video.dispatchEvent(new Event(type)));
  const play = (from: number, to: number, step = 0.25) => {
    for (let t = from; t <= to + 1e-9; t += step) {
      media.currentTime = Math.round(t * 100) / 100;
      fire('timeupdate');
    }
  };
  return { reports, playing, onEnded, ref, video, media, fire, play };
}

describe('<HlsPlayer> played ranges (real component)', () => {
  it('reports what was played on pause, never what was skipped by a seek', () => {
    const p = mount();
    p.media.currentTime = 0;
    p.media.paused = false;
    p.fire('playing');
    p.play(0, 20);
    p.media.paused = true;
    p.fire('pause');
    expect(p.playing).toEqual([true, false]);
    expect(p.reports).toEqual([
      { reason: 'pause', positionSeconds: 20, durationSeconds: 300, ranges: [{ from: 0, to: 20 }] },
    ]);

    // Seek to the end: the jump is not watched.
    p.media.seeking = true;
    p.media.currentTime = 290;
    p.fire('seeking');
    p.media.seeking = false;
    p.fire('seeked');
    expect(p.reports.at(-1)).toEqual({
      reason: 'seek',
      positionSeconds: 290,
      durationSeconds: 300,
      ranges: [],
    });

    p.media.paused = false;
    p.fire('playing');
    p.play(290, 300);
    p.media.paused = true;
    p.media.ended = true;
    p.fire('pause');
    p.fire('ended');
    expect(p.onEnded).toHaveBeenCalledTimes(1);
    expect(p.reports.at(-1)).toMatchObject({ reason: 'ended', ranges: [{ from: 290, to: 300 }] });
  });

  it('flushPlayedRanges() hands over continuous playback in pieces; seek() does not count', () => {
    const p = mount();
    p.media.paused = false;
    p.fire('playing');
    p.play(42, 57);
    expect(p.ref.current!.flushPlayedRanges()).toMatchObject({
      reason: 'flush',
      positionSeconds: 57,
      ranges: [{ from: 42, to: 57 }],
    });
    p.play(57.25, 72);
    expect(p.ref.current!.flushPlayedRanges().ranges).toEqual([{ from: 57, to: 72 }]);

    act(() => p.ref.current!.seek(150));
    expect(p.media.currentTime).toBe(150);
    expect(p.ref.current!.currentTime()).toBe(150);
    p.play(150, 151);
    expect(p.ref.current!.flushPlayedRanges().ranges).toEqual([{ from: 150, to: 151 }]);
    expect(p.ref.current!.isPlaying()).toBe(true);
  });
});
