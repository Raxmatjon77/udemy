// @vitest-environment jsdom
import { useEffect } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { HlsPlayerError } from '@udemy/ui/components/hls-player';

import { IDS } from '@/test/fixtures';
import { problem, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { LecturePlayer } from './lecture-player';

/** What the fake player reports on mount (the real one is tested in @udemy/ui). */
const playerOutcome: { error: HlsPlayerError | null; mounts: number } = { error: null, mounts: 0 };

vi.mock('@udemy/ui/components/hls-player', () => ({
  HlsPlayer: function FakePlayer({
    src,
    title,
    onError,
    className,
  }: {
    src: string;
    title: string;
    onError?: (error: HlsPlayerError) => void;
    className?: string;
  }) {
    useEffect(() => {
      playerOutcome.mounts += 1;
      if (playerOutcome.error) onError?.(playerOutcome.error);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, like the player
    }, []);
    return <div data-testid="player" data-src={src} aria-label={title} className={className} />;
  },
}));

setupMockApi();

const MASTER = `/courses/${IDS.course}/lectures/${IDS.lecture1}/preview/hls/master.m3u8`;
const SRC = `/api/proxy${MASTER}`;

function renderPlayer(error: HlsPlayerError | null) {
  playerOutcome.error = error;
  playerOutcome.mounts = 0;
  return renderWithClient(<LecturePlayer src={SRC} title="Welcome" />);
}

describe('<LecturePlayer> (working-copy preview)', () => {
  it('plays the owner preview playlist with no problem shown', () => {
    renderPlayer(null);
    expect(screen.getByTestId('player').dataset.src).toBe(SRC);
    expect(screen.queryByTestId('playback-problem')).toBeNull();
  });

  it('409 media_not_ready: says it is processing and retries with a fresh player', async () => {
    let diagnosed = 0;
    server.use(
      http.get(proxy(MASTER), () => {
        diagnosed += 1;
        return problem(409, 'media_not_ready');
      }),
    );
    const user = userEvent.setup();
    renderPlayer({ reason: 'not-ready', httpStatus: 409 });
    expect((await screen.findByTestId('playback-problem')).textContent).toMatch(
      /still being processed/,
    );
    await waitFor(() => expect(diagnosed).toBe(1));
    // The player's own overlay is hidden behind ours.
    expect(screen.getByTestId('player').className).toContain('[&>[role=alert]]:hidden');

    playerOutcome.error = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(playerOutcome.mounts).toBe(2);
    expect(screen.queryByTestId('playback-problem')).toBeNull();
  });

  it('422 lecture_type_mismatch: final, no retry', async () => {
    server.use(http.get(proxy(MASTER), () => problem(422, 'lecture_type_mismatch')));
    renderPlayer({ reason: 'network', httpStatus: 422 });
    const alert = await screen.findByTestId('playback-problem');
    await waitFor(() => expect(alert.textContent).toMatch(/not a video lecture/));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('429: reads Retry-After and keeps the retry disabled until then', async () => {
    server.use(
      http.get(proxy(MASTER), () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Too Many Requests', status: 429, code: 'rate_limited' },
          {
            status: 429,
            headers: { 'content-type': 'application/problem+json', 'retry-after': '45' },
          },
        ),
      ),
    );
    renderPlayer({ reason: 'network', httpStatus: 429 });
    await waitFor(() =>
      expect(screen.getByTestId('playback-problem').textContent).toMatch(
        /Too many playback requests\. Try again in 45 seconds\./,
      ),
    );
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('leaves 401 and network failures to the player itself', () => {
    renderPlayer({ reason: 'unauthorized', httpStatus: 401 });
    renderPlayer({ reason: 'network' });
    // No diagnostic request (MSW would fail an unhandled one) and no overlay of ours.
    expect(screen.queryByTestId('playback-problem')).toBeNull();
  });
});
