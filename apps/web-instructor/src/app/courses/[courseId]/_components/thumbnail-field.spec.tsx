// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { asset, courseDetail, IDS } from '@/test/fixtures';
import { proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { ThumbnailField } from './thumbnail-field';

setupMockApi();

const thumbnail = (status: 'READY' | 'PROCESSING' | 'FAILED') =>
  asset({
    purpose: 'COURSE_THUMBNAIL',
    status,
    originalFilename: 'cover.png',
    durationSeconds: null,
    renditions: [],
    progressPct: status === 'PROCESSING' ? 30 : null,
    failureCode: status === 'FAILED' ? 'INVALID_MEDIA' : null,
  });

describe('<ThumbnailField>', () => {
  it('shows a READY working-copy image through the signed-redirect route, keyed by asset', () => {
    renderWithClient(
      <ThumbnailField
        course={courseDetail({ thumbnailAssetId: IDS.asset, thumbnail: thumbnail('READY') })}
        readOnly={false}
      />,
    );
    const img = screen.getByRole('img', { name: 'Current course image' });
    expect(img.getAttribute('src')).toBe(
      `/media/course-thumbnail/${IDS.course}?variant=w480&v=${IDS.asset}`,
    );
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');

    // The route answered an error (e.g. the image was purged): fall back to the file name.
    fireEvent.error(img);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('cover.png')).toBeTruthy();
    expect(screen.getByText('The image could not be loaded.')).toBeTruthy();
  });

  it('requests no image while processing (the API would answer 409 media_not_ready)', async () => {
    server.use(
      http.get(proxy(`/media/assets/${IDS.asset}`), () =>
        HttpResponse.json(thumbnail('PROCESSING')),
      ),
    );
    renderWithClient(
      <ThumbnailField
        course={courseDetail({ thumbnailAssetId: IDS.asset, thumbnail: thumbnail('PROCESSING') })}
        readOnly={false}
      />,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('The image appears here once it is processed.')).toBeTruthy();
    expect(await screen.findByText('Processing')).toBeTruthy();
    expect(screen.getByText(/\(30%\)/)).toBeTruthy();
  });

  it('says why a failed image cannot be shown', () => {
    renderWithClient(
      <ThumbnailField
        course={courseDetail({ thumbnailAssetId: IDS.asset, thumbnail: thumbnail('FAILED') })}
        readOnly={false}
      />,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Failed')).toBeTruthy();
  });
});
