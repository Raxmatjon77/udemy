// @vitest-environment jsdom
import { useEffect } from 'react';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HlsPlayerError } from '@udemy/ui/components/hls-player';

import { mockApi, problem } from '@/test/api-mock';
import { LECTURE_VIDEO, REVISION_ID } from '@/test/fixtures';
import { renderWithClient } from '@/test/render';

import { LecturePlayer } from './lecture-player';

const outcome: { error: HlsPlayerError | null } = { error: null };

vi.mock('@udemy/ui/components/hls-player', () => ({
  HlsPlayer: function FakePlayer({
    src,
    onError,
  }: {
    src: string;
    onError?: (error: HlsPlayerError) => void;
  }) {
    useEffect(() => {
      if (outcome.error) onError?.(outcome.error);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, like the player
    }, []);
    return <div data-testid="player" data-src={src} />;
  },
}));

const MASTER = `/admin/course-revisions/${REVISION_ID}/lectures/${LECTURE_VIDEO}/hls/master.m3u8`;

describe('<LecturePlayer> (admin revision playback)', () => {
  it('maps a 403 on the revision playlist to a clear, final message', async () => {
    const api = mockApi({ [`GET ${MASTER}`]: () => problem(403, 'forbidden') });
    outcome.error = { reason: 'forbidden', httpStatus: 403 };
    renderWithClient(<LecturePlayer src={`/api/proxy${MASTER}`} title="Welcome video" />);
    await waitFor(() =>
      expect(screen.getByTestId('playback-problem').textContent).toMatch(
        /do not have permission to play videos of courses under review/,
      ),
    );
    expect(api.callsTo('GET', /master\.m3u8$/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('maps 422 lecture_type_mismatch', async () => {
    mockApi({ [`GET ${MASTER}`]: () => problem(422, 'lecture_type_mismatch') });
    outcome.error = { reason: 'network', httpStatus: 422 };
    renderWithClient(<LecturePlayer src={`/api/proxy${MASTER}`} title="Welcome video" />);
    await waitFor(() =>
      expect(screen.getByTestId('playback-problem').textContent).toMatch(/not a video lecture/),
    );
  });
});
