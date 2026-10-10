// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { problemResponse } from '@udemy/contracts/testing';

import { ADMIN, seedFailedRefund, seedRefundUnderReview } from '@/test/commerce';
import { installCommerceStore, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { RefundsQueue } from './refunds-queue';

setupMockApi();

const NAME = /PostgreSQL in Depth, order #\d+/;

function setup() {
  const store = installCommerceStore({ viewerId: ADMIN });
  const review = seedRefundUnderReview(store);
  return { store, review };
}

const refundOf = (store: ReturnType<typeof setup>['store'], orderId: string, id: string) =>
  store.adminOrder(orderId).refunds.find((r) => r.id === id)!;

describe('<RefundsQueue>', () => {
  it('lists requests held for review with the refund history that sent them there', async () => {
    const { review } = setup();
    expect(review.status).toBe('REQUESTED');
    renderWithClient(<RefundsQueue status="REQUESTED" />);

    const row = await screen.findByText('PostgreSQL in Depth').then((el) => el.closest('tr')!);
    expect(within(row).getByText('$49.99')).toBeTruthy();
    expect(within(row).getByText('Jane Student')).toBeTruthy();
    expect(within(row).getByText('The course is not what I expected')).toBeTruthy();
    expect(within(row).getByText('The course skips the basics.')).toBeTruthy();
    // the mock counts the pending request too (3 approved + this one)
    expect(within(row).getByText('4 in 90 days')).toBeTruthy();
    expect(within(row).getByText('3 or more refunds send a request to review')).toBeTruthy();
    expect(
      within(row)
        .getByRole('link', { name: /Order #/ })
        .getAttribute('href'),
    ).toBe(`/orders/${review.orderId}`);
    expect(screen.getByRole('link', { name: 'Needs review' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('approves with an optional note', async () => {
    const { store, review } = setup();
    const { user } = renderWithClient(<RefundsQueue status="REQUESTED" />);
    await user.click(
      await screen.findByRole('button', { name: new RegExp(`Approve refund: ${NAME.source}`) }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/Jane Student loses access/)).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Approve refund' }));

    expect(await screen.findByText(/^Approved the refund of PostgreSQL in Depth/)).toBeTruthy();
    expect(await screen.findByText('No refunds waiting for review.')).toBeTruthy();
    expect(refundOf(store, review.orderId, review.refundId).status).toBe('APPROVED');
  });

  it('rejects only with a reason of at least 10 characters', async () => {
    const { store, review } = setup();
    const { user } = renderWithClient(<RefundsQueue status="REQUESTED" />);
    await user.click(
      await screen.findByRole('button', { name: new RegExp(`Reject refund: ${NAME.source}`) }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Reject refund' }));
    expect(await dialog.findByText('Must be at least 10 characters.')).toBeTruthy();
    await user.type(dialog.getByLabelText('Reason'), 'Most of the course was already watched.');
    await user.click(dialog.getByRole('button', { name: 'Reject refund' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('No refunds waiting for review.')).toBeTruthy();
    const refund = refundOf(store, review.orderId, review.refundId);
    expect(refund.status).toBe('REJECTED');
    expect(refund.rejectionReason).toBe('Most of the course was already watched.');
  });

  it('explains a decision another admin already made and refreshes the queue', async () => {
    const { store, review } = setup();
    const { user } = renderWithClient(<RefundsQueue status="REQUESTED" />);
    const approve = await screen.findByRole('button', {
      name: new RegExp(`Approve refund: ${NAME.source}`),
    });
    // someone else approves it first
    store.decideRefund(review.refundId, 'approve');
    await user.click(approve);
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Approve refund' }));
    expect(
      await dialog.findByText(
        'Another admin already handled this refund. The queue was refreshed.',
      ),
    ).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('No refunds waiting for review.')).toBeTruthy();
  });

  it('shows other errors in the dialog', async () => {
    setup();
    server.use(
      http.post(proxy('/admin/refunds/:refundId/approve'), () =>
        problemResponse(503, 'service_unavailable'),
      ),
    );
    const { user } = renderWithClient(<RefundsQueue status="REQUESTED" />);
    await user.click(
      await screen.findByRole('button', { name: new RegExp(`Approve refund: ${NAME.source}`) }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Approve refund' }));
    expect(
      await dialog.findByText(
        'The service is temporarily unavailable. Please try again in a moment.',
      ),
    ).toBeTruthy();
  });

  it('retries a failed refund, and links to the buyer to re-grant access', async () => {
    const store = installCommerceStore({ viewerId: ADMIN });
    const failed = seedFailedRefund(store);
    const { user } = renderWithClient(<RefundsQueue status="FAILED" />);

    const row = await screen.findByText('Complete TypeScript').then((el) => el.closest('tr')!);
    expect(within(row).getByText('charge_disputed')).toBeTruthy();
    expect(within(row).getByText('Attempt 1')).toBeTruthy();
    expect(
      within(row)
        .getByRole('link', { name: /Re-grant access/ })
        .getAttribute('href'),
    ).toMatch(/^\/users\//);

    await user.click(within(row).getByRole('button', { name: /Retry refund/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/attempt 2/)).toBeTruthy();
    await user.type(dialog.getByLabelText('Note'), 'Card dispute resolved.');
    await user.click(dialog.getByRole('button', { name: 'Retry refund' }));

    expect(await screen.findByText('No failed refunds.')).toBeTruthy();
    const refund = refundOf(store, failed.orderId, failed.refundId);
    expect(refund.status).toBe('APPROVED');
    expect(refund.attempt).toBe(2);
  });
});
