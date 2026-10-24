// @vitest-environment jsdom
import { focusManager } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ArticleSchema, MEDIA_FAILURE_LABELS, SaveArticleRequestSchema } from '@udemy/contracts';
import { LEARNING_FIXTURE_IDS } from '@udemy/contracts/testing';

import { asset, IDS, lecture, markdownNotAllowed, signedUrl } from '@/test/fixtures';
import { COURSE, installLearning } from '@/test/learning';
import { problem, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { ArticleForm, LectureDrawer } from './lecture-drawer';

const startDownload = vi.fn();
vi.mock('@/lib/download', () => ({ startDownload: (url: string) => startDownload(url) }));

// The player loads hls.js on mount; not needed for these specs.
vi.mock('@udemy/ui/components/hls-player', () => ({
  HlsPlayer: ({ src, title }: { src: string; title: string }) => (
    <div data-testid="player" data-src={src} aria-label={title} />
  ),
}));

setupMockApi();

describe('article editor', () => {
  it('shows each markdown_not_allowed issue with its line and column, and jumps there', async () => {
    let sent: unknown;
    server.use(
      http.put(
        proxy(`/courses/${IDS.course}/lectures/${IDS.lecture2}/article`),
        async ({ request }) => {
          sent = SaveArticleRequestSchema.parse(await request.json());
          return HttpResponse.json(
            markdownNotAllowed([
              {
                path: 'bodyMd',
                line: 3,
                column: 1,
                kind: 'raw_html',
                construct: 'html_inline',
                detail: 'Raw HTML is not allowed.',
              },
              {
                path: 'bodyMd',
                line: 5,
                column: 3,
                kind: 'image',
                construct: 'image',
                detail: 'Images are not allowed.',
              },
            ]),
            { status: 422, headers: { 'content-type': 'application/problem+json' } },
          );
        },
      ),
      http.get(
        proxy(`/courses/${IDS.course}/curriculum`),
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderWithClient(
      <ArticleForm
        courseId={IDS.course}
        lectureId={IDS.lecture2}
        initial={'# Intro\n\nHello'}
        readOnly={false}
      />,
    );

    const textarea = screen.getByRole('textbox', { name: 'Article' }) as HTMLTextAreaElement;
    await user.type(textarea, '{Enter}<b>x</b>');
    // The live preview renders the same markdown as students see (raw HTML is dropped).
    expect(screen.getByRole('region', { name: 'Article preview' }).textContent).toContain('Intro');
    await user.click(screen.getByRole('button', { name: 'Save article' }));

    expect(await screen.findByText('Some formatting is not allowed')).toBeTruthy();
    expect(sent).toEqual({ bodyMd: '# Intro\n\nHello\n<b>x</b>' });
    const issues = screen.getByRole('list', { name: 'Formatting problems' });
    expect(issues.textContent).toContain('Line 3, column 1: Raw HTML is not allowed.');
    expect(issues.textContent).toContain('Line 5, column 3: Images are not allowed.');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Line 3, column 1' }));
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe('# Intro\n\n'.length);
  });

  it('saves a valid article', async () => {
    server.use(
      http.put(
        proxy(`/courses/${IDS.course}/lectures/${IDS.lecture2}/article`),
        async ({ request }) => {
          const { bodyMd } = SaveArticleRequestSchema.parse(await request.json());
          return HttpResponse.json(
            ArticleSchema.parse({
              lectureId: IDS.lecture2,
              bodyMd,
              updatedAt: '2026-10-10T11:00:00.000Z',
            }),
          );
        },
      ),
      http.get(
        proxy(`/courses/${IDS.course}/curriculum`),
        () => new HttpResponse(null, { status: 500 }),
      ),
      http.get(proxy(`/courses/${IDS.course}`), () => new HttpResponse(null, { status: 500 })),
    );
    const user = userEvent.setup();
    renderWithClient(
      <ArticleForm courseId={IDS.course} lectureId={IDS.lecture2} initial="" readOnly={false} />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Article' }), 'Plain **text**');
    await user.click(screen.getByRole('button', { name: 'Save article' }));
    expect(await screen.findByText('Article saved.')).toBeTruthy();
    expect(screen.queryByText('Some formatting is not allowed')).toBeNull();
  });
});

describe('video lecture', () => {
  it('polls a processing video until it fails and shows the contracts failure label', async () => {
    let polls = 0;
    server.use(
      http.get(proxy(`/media/assets/${IDS.asset}`), () => {
        polls += 1;
        return HttpResponse.json(
          polls < 2
            ? asset({ status: 'PROCESSING', progressPct: 40, durationSeconds: null })
            : asset({ status: 'FAILED', failureCode: 'UNSUPPORTED_MEDIA', durationSeconds: null }),
        );
      }),
      http.get(
        proxy(`/courses/${IDS.course}/curriculum`),
        () => new HttpResponse(null, { status: 500 }),
      ),
      http.get(proxy(`/courses/${IDS.course}`), () => new HttpResponse(null, { status: 500 })),
    );
    // jsdom reports a hidden document; polling only runs for a focused window.
    focusManager.setFocused(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderWithClient(
        <LectureDrawer
          courseId={IDS.course}
          readOnly={false}
          onClose={() => {}}
          lecture={lecture({
            id: IDS.lecture1,
            sectionId: IDS.sectionA,
            position: 0,
            title: 'Welcome',
            mediaAssetId: IDS.asset,
            asset: asset({ status: 'PROCESSING', progressPct: 10, durationSeconds: null }),
          })}
        />,
      );
      expect(await screen.findByLabelText('Processing progress')).toBeTruthy();
      // Polls every 3 s until the asset is terminal.
      for (
        let i = 0;
        i < 5 && !screen.queryByText(MEDIA_FAILURE_LABELS.UNSUPPORTED_MEDIA);
        i += 1
      ) {
        await vi.advanceTimersByTimeAsync(3_000);
      }
      expect(await screen.findByText(MEDIA_FAILURE_LABELS.UNSUPPORTED_MEDIA)).toBeTruthy();
      expect(polls).toBe(2);
      const count = polls;
      await vi.advanceTimersByTimeAsync(6_500);
      expect(polls).toBe(count); // terminal: polling stopped
      expect(screen.queryByTestId('player')).toBeNull();
    } finally {
      vi.useRealTimers();
      focusManager.setFocused(undefined);
    }
  });

  it('plays a ready video through the owner preview playlist', async () => {
    renderWithClient(
      <LectureDrawer
        courseId={IDS.course}
        readOnly={false}
        onClose={() => {}}
        lecture={lecture({
          id: IDS.lecture1,
          sectionId: IDS.sectionA,
          position: 0,
          title: 'Welcome',
          mediaAssetId: IDS.asset,
          asset: asset(),
        })}
      />,
    );
    const player = await screen.findByTestId('player');
    expect(player.dataset.src).toBe(
      `/api/proxy/courses/${IDS.course}/lectures/${IDS.lecture1}/preview/hls/master.m3u8`,
    );
    // Previewable type: the toggle is enabled.
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: 'Free preview' }) as HTMLInputElement).disabled,
      ).toBe(false),
    );
  });
});

describe('resource lecture', () => {
  const resource = (status: 'READY' | 'PROCESSING' = 'READY') =>
    lecture({
      id: IDS.lecture3,
      sectionId: IDS.sectionB,
      position: 0,
      title: 'Cheat sheet',
      type: 'RESOURCE',
      mediaAssetId: IDS.asset,
      asset: asset({
        purpose: 'LECTURE_RESOURCE',
        status,
        originalFilename: 'cheatsheet.pdf',
        durationSeconds: null,
        width: null,
        height: null,
        renditions: [],
        progressPct: status === 'PROCESSING' ? 50 : null,
      }),
    });

  it('downloads the working-copy file through GET /courses/:c/lectures/:l/download', async () => {
    startDownload.mockReset();
    const file = signedUrl('res/cheatsheet.pdf');
    server.use(
      http.get(proxy(`/courses/${IDS.course}/lectures/${IDS.lecture3}/download`), () =>
        HttpResponse.json(file),
      ),
    );
    const user = userEvent.setup();
    renderWithClient(
      <LectureDrawer
        courseId={IDS.course}
        readOnly={false}
        onClose={() => {}}
        lecture={resource()}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Download file' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledWith(file.url));
  });

  it('explains 409 media_not_ready instead of downloading', async () => {
    startDownload.mockReset();
    server.use(
      http.get(proxy(`/courses/${IDS.course}/lectures/${IDS.lecture3}/download`), () =>
        problem(409, 'media_not_ready'),
      ),
      http.get(
        proxy(`/courses/${IDS.course}/curriculum`),
        () => new HttpResponse(null, { status: 500 }),
      ),
      http.get(proxy(`/courses/${IDS.course}`), () => new HttpResponse(null, { status: 500 })),
    );
    const user = userEvent.setup();
    renderWithClient(
      <LectureDrawer
        courseId={IDS.course}
        readOnly={false}
        onClose={() => {}}
        lecture={resource()}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Download file' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not ready to download yet/);
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('offers no download while the file is still processing', async () => {
    server.use(
      http.get(proxy(`/media/assets/${IDS.asset}`), () =>
        HttpResponse.json(
          asset({
            purpose: 'LECTURE_RESOURCE',
            status: 'PROCESSING',
            originalFilename: 'cheatsheet.pdf',
            durationSeconds: null,
            width: null,
            height: null,
            renditions: [],
            progressPct: 50,
          }),
        ),
      ),
    );
    renderWithClient(
      <LectureDrawer
        courseId={IDS.course}
        readOnly={false}
        onClose={() => {}}
        lecture={resource('PROCESSING')}
      />,
    );
    expect(await screen.findByLabelText('Processing progress')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download file' })).toBeNull();
  });
});

describe('quiz lecture (Phase 5)', () => {
  it('opens the quiz editor instead of a media panel, without a preview option', async () => {
    installLearning();
    const quizLecture = lecture({
      id: LEARNING_FIXTURE_IDS.lectureQuiz,
      sectionId: IDS.sectionA,
      position: 0,
      type: 'QUIZ',
      title: 'Check yourself',
      quiz: { passPct: 70, questionCount: 3 },
    });
    renderWithClient(
      <LectureDrawer courseId={COURSE} lecture={quizLecture} readOnly={false} onClose={() => {}} />,
    );
    expect(await screen.findByRole('listitem', { name: 'Question 3' })).toBeTruthy();
    expect(screen.getByText('Quiz lectures cannot be previews.')).toBeTruthy();
    expect(screen.queryByText(/Upload/)).toBeNull();
  });
});
