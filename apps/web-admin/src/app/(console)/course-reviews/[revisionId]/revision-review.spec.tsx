// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { json, mockApi, problem } from '@/test/api-mock';
import {
  ADMIN_ID,
  COURSE_ID,
  courseDetail,
  LECTURE_MOVED,
  LECTURE_RESOURCE,
  LECTURE_VIDEO,
  OWNER_ID,
  REVISION_ID,
  revisionReview,
  signedUrl,
} from '@/test/fixtures';
import { renderWithClient } from '@/test/render';

import { RevisionReview } from './revision-review';

const startDownload = vi.fn();
vi.mock('@/lib/download', () => ({ startDownload: (url: string) => startDownload(url) }));

// hls.js needs MediaSource; the player itself is covered in @udemy/ui. Here we only check that
// the admin revision playlist is what gets played.
vi.mock('@udemy/ui/components/hls-player', () => ({
  HlsPlayer: ({ src, title }: { src: string; title: string }) => (
    <div data-testid="hls-player" data-src={src} aria-label={title} />
  ),
}));

const DETAIL = `/admin/course-revisions/${REVISION_ID}`;
const RESOURCE_DOWNLOAD = `${DETAIL}/lectures/${LECTURE_RESOURCE}/download`;
const APPROVE = `/admin/courses/${COURSE_ID}/revisions/${REVISION_ID}/approve`;
const REJECT = `/admin/courses/${COURSE_ID}/revisions/${REVISION_ID}/reject`;

function setup(
  options: {
    review?: ReturnType<typeof revisionReview>;
    afterDecision?: ReturnType<typeof revisionReview>;
    approve?: () => Response;
    reject?: () => Response;
    download?: () => Response;
    currentUserId?: string | null;
  } = {},
) {
  let decided = false;
  const api = mockApi({
    [`GET ${DETAIL}`]: () =>
      json(
        decided && options.afterDecision
          ? options.afterDecision
          : (options.review ?? revisionReview()),
      ),
    [`GET ${RESOURCE_DOWNLOAD}`]: () => options.download?.() ?? json(signedUrl('res/slides.pdf')),
    [`POST ${APPROVE}`]: () => {
      decided = true;
      return options.approve?.() ?? json(courseDetail());
    },
    [`POST ${REJECT}`]: () => {
      decided = true;
      return options.reject?.() ?? json(courseDetail({ status: 'PUBLISHED' }));
    },
  });
  const rendered = renderWithClient(
    <RevisionReview
      revisionId={REVISION_ID}
      currentUserId={options.currentUserId === undefined ? ADMIN_ID : options.currentUserId}
    />,
  );
  return { api, ...rendered };
}

describe('<RevisionReview>: the snapshot', () => {
  it('renders details, markdown, curriculum with durations and the instructor note', async () => {
    setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: /TypeScript from zero/ }),
    ).toBeTruthy();

    // Description markdown: bold text and a heading shifted to h3.
    const description = within(
      document.querySelector<HTMLElement>('[data-field="descriptionMd"]')!,
    );
    expect(description.getByText('TypeScript', { selector: 'strong' })).toBeTruthy();
    expect(description.getByRole('heading', { level: 4, name: 'What is inside' })).toBeTruthy();

    expect(screen.getByText('Types, generics and tooling for working developers')).toBeTruthy();
    const category = document.querySelector('[data-field="categoryId"] dd')!;
    expect(category.textContent).toBe('Development › Web development');
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText('Beginner')).toBeTruthy();
    expect(
      within(document.querySelector<HTMLElement>('[data-field="outcomes"]')!).getByText(
        'Use generics',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Basic JavaScript')).toBeTruthy();
    expect(screen.getByText('cover.png')).toBeTruthy();
    expect(screen.getByText('Fixed the audio in the welcome video.')).toBeTruthy();
    expect(
      screen.getByText(/4 lectures in 2 sections · 13 min of video · 1 free preview/),
    ).toBeTruthy();

    const video = screen.getByTestId(`lecture-${LECTURE_VIDEO}`);
    expect(within(video).getByText('Video')).toBeTruthy();
    expect(within(video).getByText('Free preview')).toBeTruthy();
    expect(within(video).getByText('12:34')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Section 2: Generics' })).toBeTruthy();
  });

  it('plays a video lecture through the admin revision playlist', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Play Welcome video' }));
    const player = screen.getByTestId('hls-player');
    expect(player.getAttribute('data-src')).toBe(
      `/api/proxy/admin/course-revisions/${REVISION_ID}/lectures/${LECTURE_VIDEO}/hls/master.m3u8`,
    );
    expect(player.getAttribute('aria-label')).toBe('Welcome video');

    await user.click(screen.getByRole('button', { name: 'Hide Welcome video' }));
    expect(screen.queryByTestId('hls-player')).toBeNull();
  });

  it('renders an article lecture with <MarkdownView>', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Read Reading list' }));
    const article = screen.getByRole('article', { name: 'Article: Reading list' });
    expect(within(article).getByText('handbook', { selector: 'em' })).toBeTruthy();
    expect(within(article).getByText('const x: number = 1;', { exact: false })).toBeTruthy();
  });

  it('says why a video without a ready asset cannot be played, and shows resource files', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Play Generic functions' }));
    expect(screen.getByText('No file attached.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Details Cheat sheet' }));
    expect(screen.getByText('slides.pdf')).toBeTruthy();
  });

  it('shows the revision thumbnail through the admin signed-redirect route', async () => {
    setup();
    const img = await screen.findByRole('img', { name: 'Course image of this revision' });
    expect(img.getAttribute('src')).toBe(`/media/revision-thumbnail/${REVISION_ID}?variant=w480`);
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('downloads a RESOURCE file through the admin revision download route', async () => {
    startDownload.mockReset();
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Details Cheat sheet' }));
    await user.click(screen.getByRole('button', { name: 'Download slides.pdf' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(startDownload.mock.calls[0]?.[0]).toBe(signedUrl('res/slides.pdf').url);
    expect(api.callsTo('GET', /\/download$/).map((c) => c.path)).toEqual([RESOURCE_DOWNLOAD]);
  });

  it('explains 409 media_not_ready on a download', async () => {
    startDownload.mockReset();
    const { user } = setup({ download: () => problem(409, 'media_not_ready') });
    await user.click(await screen.findByRole('button', { name: 'Details Cheat sheet' }));
    await user.click(screen.getByRole('button', { name: 'Download slides.pdf' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not ready to download/);
    expect(startDownload).not.toHaveBeenCalled();
  });
});

describe('<RevisionReview>: the diff against the live revision', () => {
  it('marks changed fields and added, changed and moved items, and lists removed ones by title', async () => {
    setup();
    await screen.findByRole('heading', { level: 1 });

    const changedFields = screen.getByRole('list', { name: 'Changed details' });
    const changes = [...changedFields.querySelectorAll('[data-field-change]')];
    expect(changes.map((li) => li.getAttribute('data-field-change'))).toEqual([
      'title',
      'descriptionMd',
      'outcomes',
    ]);
    const side = (field: string, which: 'before' | 'after') =>
      changedFields.querySelector(`[data-field-change="${field}"] [data-side="${which}"] dd`)!;
    expect(side('title', 'before').textContent).toBe('TypeScript basics');
    expect(side('title', 'after').textContent).toBe('TypeScript from zero');
    // Markdown is rendered (sanitized), not shown as source.
    expect(
      within(side('descriptionMd', 'before') as HTMLElement).getByText('TypeScript').tagName,
    ).toBe('EM');
    expect(
      within(side('descriptionMd', 'after') as HTMLElement).getByText('TypeScript').tagName,
    ).toBe('STRONG');
    expect(
      within(side('outcomes', 'after') as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Write typed code', 'Use generics', 'Configure tsc', 'Read compiler errors']);
    expect(document.querySelector('[data-field="title"][data-changed]')).not.toBeNull();
    expect(document.querySelector('[data-field="descriptionMd"][data-changed]')).not.toBeNull();
    expect(document.querySelector('[data-field="subtitle"][data-changed]')).toBeNull();

    const sectionTwo = screen.getByRole('region', { name: 'Section 2: Generics' });
    expect(sectionTwo.querySelector('[data-change="added"]')?.textContent).toBe('New');
    const sectionOne = screen.getByRole('region', { name: 'Section 1: Getting started' });
    expect(sectionOne.querySelector('h3 ~ [data-change="changed"]')?.textContent).toBe('Changed');

    const change = (lectureId: string) =>
      [...screen.getByTestId(`lecture-${lectureId}`).querySelectorAll('[data-change]')].map(
        (el) => el.textContent,
      );
    expect(change(LECTURE_VIDEO)).toEqual(['Changed']);
    expect(change(LECTURE_MOVED)).toEqual(['Moved']);
    expect(change(LECTURE_RESOURCE)).toEqual(['New']);

    expect(screen.getByText('Old appendix')).toBeTruthy();
    expect(screen.getByText('Outdated setup guide')).toBeTruthy();
    expect(screen.getByText('in section “Old appendix”')).toBeTruthy();
    expect(
      screen.getByText(
        '1 sections added, 1 sections changed, 1 sections removed, 1 lectures added, 1 lectures changed, 1 lectures moved, 1 lectures removed.',
      ),
    ).toBeTruthy();
  });

  it('falls back to field names (no before/after) and plain removed lectures for an older API', async () => {
    setup({ review: revisionReview({ legacy: true }) });
    await screen.findByRole('heading', { level: 1 });
    const changedFields = screen.getByRole('list', { name: 'Changed details' });
    expect(
      within(changedFields)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Title', 'Description', 'Learning outcomes']);
    expect(screen.queryByText(/in section/)).toBeNull();
    expect(document.querySelector('[data-field="categoryId"] dd')!.textContent).toBe(
      'Web development',
    );
  });

  it('shows no diff marks for an INITIAL revision', async () => {
    setup({ review: revisionReview({ kind: 'INITIAL' }) });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(/first submission of this course/)).toBeTruthy();
    expect(document.querySelectorAll('[data-change]')).toHaveLength(0);
  });
});

describe('<RevisionReview>: decisions', () => {
  it('approves with an optional note and the expected version', async () => {
    const { api, user } = setup({
      afterDecision: revisionReview({ state: 'LIVE', pendingRevisionId: null }),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this revision?' });
    await user.type(within(dialog).getByLabelText(/Note/), 'Nice work');
    await user.click(within(dialog).getByRole('button', { name: 'Approve and publish' }));

    expect(await screen.findByText(/Approved\. This revision is now live/)).toBeTruthy();
    expect(api.callsTo('POST', /\/approve$/).map((c) => c.body)).toEqual([
      { note: 'Nice work', expectedVersion: 7 },
    ]);
    // The detail is refetched: the revision is now live.
    expect(await screen.findByText('Live')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('approves without a note', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Approve and publish' }));
    await screen.findByText(/Approved\./);
    expect(api.callsTo('POST', /\/approve$/)[0]?.body).toEqual({ expectedVersion: 7 });
  });

  it('requires a reject reason of at least 10 characters', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this revision?' });
    const reason = within(dialog).getByLabelText(/Reason/);
    await user.type(reason, 'Too short');
    await user.click(within(dialog).getByRole('button', { name: 'Reject revision' }));
    expect(await within(dialog).findByText('Must be at least 10 characters.')).toBeTruthy();
    expect(api.callsTo('POST', /\/reject$/)).toHaveLength(0);

    await user.type(reason, ' — the audio in lecture 2 is clipped.');
    await user.click(within(dialog).getByRole('button', { name: 'Reject revision' }));
    expect(await screen.findByText(/Rejected\. The instructor was notified/)).toBeTruthy();
    expect(api.callsTo('POST', /\/reject$/).map((c) => c.body)).toEqual([
      { reason: 'Too short — the audio in lecture 2 is clipped.', expectedVersion: 7 },
    ]);
  });

  it('on version_conflict explains it and offers to reload the revision', async () => {
    const { api, user } = setup({
      approve: () => problem(409, 'version_conflict'),
      afterDecision: revisionReview({ version: 9 }),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve and publish' }));

    expect(
      await within(dialog).findByText(/The course changed while you were reviewing it/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Reload revision' }));
    // Reloaded: the decision buttons come back with the new version.
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Approve and publish' }));
    await waitFor(() => expect(api.callsTo('POST', /\/approve$/)).toHaveLength(2));
    expect(api.callsTo('POST', /\/approve$/)[1]?.body).toEqual({ expectedVersion: 9 });
    expect(api.callsTo('GET', /course-revisions/).length).toBeGreaterThanOrEqual(2);
  });

  it('on invalid_state_transition (stale tab) explains it; after reloading the revision is no longer decidable', async () => {
    const { user } = setup({
      reject: () => problem(409, 'invalid_state_transition'),
      afterDecision: revisionReview({ state: 'WITHDRAWN', pendingRevisionId: null }),
    });
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Please fix the audio levels.');
    await user.click(within(dialog).getByRole('button', { name: 'Reject revision' }));
    expect(await within(dialog).findByText(/no longer waiting for review/)).toBeTruthy();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Reload revision' }));
    expect(await screen.findByText('This revision is not waiting for a decision.')).toBeTruthy();
    expect(screen.getByText('Withdrawn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('explains self_decision_forbidden', async () => {
    const { user } = setup({ approve: () => problem(403, 'self_decision_forbidden') });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve and publish' }));
    expect(
      await within(dialog).findByText(/cannot approve or reject your own course/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload revision' })).toBeNull();
  });

  it('does not offer a decision on the reviewer’s own course', async () => {
    setup({ currentUserId: OWNER_ID });
    expect(await screen.findByText(/This is your own course/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
