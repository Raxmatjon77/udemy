'use client';

import { LEARNING_PROGRESS_RULES, type ProgressAck } from '@udemy/contracts';
import type { HlsPlayerHandle, PlayedRangesReport } from '@udemy/ui/components/hls-player';
import { useEffect, useMemo, type RefObject } from 'react';

import { isApiError } from '../problem';
import { sendHeartbeat } from './client';
import { HeartbeatSender, type HeartbeatFailure } from './heartbeat';

export interface ProgressHeartbeatOptions {
  courseId: string;
  lectureId: string;
  /** False in PREVIEW mode (owner) or while the bootstrap is unknown: nothing is sent. */
  enabled: boolean;
  durationSeconds: number | null;
  player: RefObject<HlsPlayerHandle | null>;
  /** The video is playing (from `HlsPlayer.onPlayingChange`). */
  playing: boolean;
  onAck?: (ack: ProgressAck) => void;
  onStopped?: (failure: HeartbeatFailure) => void;
  /** Override for tests; default `LEARNING_PROGRESS_RULES.heartbeatIntervalSeconds`. */
  intervalMs?: number;
}

/**
 * Wires a `HeartbeatSender` to the player and the page lifecycle (design §10): a beat every
 * 15 s while playing in a visible tab, one on pause/seek/end (`onPlayedRanges`), and a
 * `keepalive` beat when the tab is hidden, on `pagehide` and when the lecture is left.
 * Returns the `onPlayedRanges` callback for `<HlsPlayer>`.
 */
export function useProgressHeartbeat({
  courseId,
  lectureId,
  enabled,
  durationSeconds,
  player,
  playing,
  onAck,
  onStopped,
  intervalMs = LEARNING_PROGRESS_RULES.heartbeatIntervalSeconds * 1000,
}: ProgressHeartbeatOptions): { onPlayedRanges: (report: PlayedRangesReport) => void } {
  const sender = useMemo(
    () =>
      enabled
        ? new HeartbeatSender({
            durationSeconds,
            send: (body, { keepalive }) => sendHeartbeat(courseId, lectureId, body, { keepalive }),
            statusOf: (error) => (isApiError(error) ? error.status : null),
          })
        : null,
    [enabled, courseId, lectureId, durationSeconds],
  );
  // The latest callbacks, used when an ack arrives.
  useEffect(() => {
    sender?.setListeners({ onAck, onStopped });
  });

  // Every interval while playing; skipped while the tab is hidden (the hide beat covered it).
  useEffect(() => {
    if (!sender || !playing) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const report = player.current?.flushPlayedRanges();
      if (report) sender.record(report.ranges, report.positionSeconds);
      void sender.flush();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [sender, playing, player, intervalMs]);

  // Tab hidden, page left, lecture left: hand over what was played with keepalive.
  useEffect(() => {
    if (!sender) return;
    // The handle exists by now (set in the player's layout effect); refs are cleared before
    // this effect's cleanup runs, so keep it.
    const handle = player.current;
    const leave = () => {
      const report = handle?.flushPlayedRanges();
      if (report) sender.record(report.ranges, report.positionSeconds);
      void sender.flush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [sender, player]);

  return {
    onPlayedRanges: (report) => {
      if (!sender) return;
      sender.record(report.ranges, report.positionSeconds);
      void sender.flush();
    },
  };
}
