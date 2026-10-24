// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { makeModerationQueueItem } from '@udemy/contracts/testing';

import {
  asStudent,
  COURSE,
  installLearning,
  REPORTERS,
  seedReportedReview,
  STUDENT,
} from '@/test/learning';
import { proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { ModerationQueue } from './moderation-queue';

setupMockApi();

const REASON = 'Advertising another course, against the rules.';

async function itemCard() {
  const list = await screen.findByRole('list', { name: 'Reported content' });
  return within(list).getAllByRole('listitem')[0]!;
}

describe('<ModerationQueue>', () => {
  it('shows the reported review with its preview, reports and status', async () => {
    const store = installLearning();
    seedReportedReview(store, 1);
    renderWithClient(<ModerationQueue type={null} status="OPEN" />);

    const card = within(await itemCard());
    expect(card.getByRole('heading', { name: /Review in Complete TypeScript/ })).toBeTruthy();
    expect(card.getByText('Visible')).toBeTruthy();
    expect(card.getByText('1 open report')).toBeTruthy();
    expect(card.getByText('Terrible course, buy mine instead at spam.example')).toBeTruthy();
    expect(card.getByText(/1 out of 5 stars/)).toBeTruthy();
    expect(card.getByText('Spam or advertising')).toBeTruthy();
    expect(card.getByText(new RegExp(`by ${REPORTERS[0].displayName}`))).toBeTruthy();
    expect(card.queryByRole('button', { name: /Restore/ })).toBeNull();
  });

  it('renders question bodies as markdown', async () => {
    const store = installLearning();
    store.commerce.seedEnrollment(STUDENT, COURSE);
    for (const reporter of REPORTERS) store.commerce.seedEnrollment(reporter.id, COURSE);
    const question = asStudent(store, () =>
      store.askQuestion(COURSE, { title: 'Buy cheap pills here', bodyMd: 'Visit **now**' }),
    );
    store.seedReport('QUESTION', question.id, REPORTERS[0].id, 'SPAM');
    renderWithClient(<ModerationQueue type="QUESTION" status="OPEN" />);

    const card = within(await itemCard());
    expect(card.getByText('Buy cheap pills here')).toBeTruthy();
    expect(card.getByText('now').tagName).toBe('STRONG');
  });

  it('hides a visible review with a reason; the reports are actioned', async () => {
    const store = installLearning();
    const reviewId = seedReportedReview(store, 1);
    const { user } = renderWithClient(<ModerationQueue type={null} status="OPEN" />);

    const card = within(await itemCard());
    await user.click(card.getByRole('button', { name: /^Hide:/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Hide' }));
    expect(await dialog.findByText(/at least 10/i)).toBeTruthy();
    await user.type(dialog.getByLabelText('Reason'), REASON);
    await user.click(dialog.getByRole('button', { name: 'Hide' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(EMPTY_OPEN)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Hid the review');
    const [item] = store.moderationQueue({ status: 'ACTIONED' });
    expect(item!.subjectId).toBe(reviewId);
    expect(item!.moderationStatus).toBe('HIDDEN');
    expect(item!.actions.at(-1)).toMatchObject({ action: 'HIDE', reason: REASON });
  });

  it('restores auto-hidden content and shows the automatic action in the history', async () => {
    const store = installLearning();
    seedReportedReview(store, 3);
    const { user } = renderWithClient(<ModerationQueue type="REVIEW" status="OPEN" />);

    const card = within(await itemCard());
    expect(card.getByRole('heading', { level: 2 }).textContent).toContain('Hidden');
    expect(card.getByText(/Automatic \(report threshold\)/)).toBeTruthy();
    expect(card.getByRole('button', { name: /^Confirm hide:/ })).toBeTruthy();
    await user.click(card.getByRole('button', { name: /^Restore:/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), 'Legitimate criticism, not spam.');
    await user.click(dialog.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [item] = store.moderationQueue({ status: 'DISMISSED' });
    expect(item!.moderationStatus).toBe('VISIBLE');
  });

  it('dismisses the reports of visible content', async () => {
    const store = installLearning();
    seedReportedReview(store, 2);
    const { user } = renderWithClient(<ModerationQueue type={null} status="OPEN" />);
    const card = within(await itemCard());
    await user.click(card.getByRole('button', { name: /^Dismiss reports:/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), 'Honest opinion about the course.');
    await user.click(dialog.getByRole('button', { name: 'Dismiss reports' }));
    expect(await screen.findByText(EMPTY_OPEN)).toBeTruthy();
    expect(store.moderationQueue({ status: 'DISMISSED' })[0]!.moderationStatus).toBe('VISIBLE');
  });

  it('explains a 409 (already moderated) in the dialog and refreshes the queue', async () => {
    const store = installLearning();
    const reviewId = seedReportedReview(store, 1);
    const { user } = renderWithClient(<ModerationQueue type={null} status="OPEN" />);
    const card = within(await itemCard());
    // Another admin dismissed the reports meanwhile.
    store.moderate('REVIEW', reviewId, 'dismiss-reports', 'Handled by someone else.');

    await user.click(card.getByRole('button', { name: /^Dismiss reports:/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), 'Honest opinion about the course.');
    await user.click(dialog.getByRole('button', { name: 'Dismiss reports' }));
    expect(
      await dialog.findByText('This item was already moderated. The queue was refreshed.'),
    ).toBeTruthy();
  });

  it('pages with Load more', async () => {
    installLearning();
    const item = (n: number) =>
      makeModerationQueueItem({
        subjectId: `0b1f6d1e-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
      });
    server.use(
      http.get(proxy('/admin/moderation/reports'), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json(
          cursor ? { items: [item(2)], nextCursor: null } : { items: [item(1)], nextCursor: 'c2' },
        );
      }),
    );
    const { user } = renderWithClient(<ModerationQueue type={null} status="OPEN" />);
    const list = await screen.findByRole('list', { name: 'Reported content' });
    expect(within(list).getAllByRole('heading', { level: 2 })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /Load more/ }));
    await waitFor(() => expect(within(list).getAllByRole('heading', { level: 2 })).toHaveLength(2));
  });
});

const EMPTY_OPEN = 'Nothing to review: no content has open reports.';
