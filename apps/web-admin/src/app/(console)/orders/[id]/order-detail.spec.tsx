// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { FIXTURE_IDS, problemResponse } from '@udemy/contracts/testing';

import { ADMIN, seedPaymentReviewOrder, STUDENT } from '@/test/commerce';
import { installCommerceStore, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { OrderDetailView } from './order-detail';

setupMockApi();

const REASON = 'Buyer reported the course was mis-described.';

function seedTwoLineOrder() {
  const store = installCommerceStore({ viewerId: ADMIN });
  const order = store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course, FIXTURE_IDS.course2]);
  return { store, order };
}

describe('<OrderDetailView>', () => {
  it('shows the lines with the instructor and platform shares', async () => {
    const { order } = seedTwoLineOrder();
    renderWithClient(<OrderDetailView id={order.id} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: `Order #${order.orderNumber} Paid` }),
    ).toBeTruthy();
    const line1 = screen.getByTestId('line-1');
    expect(within(line1).getByText('Complete TypeScript')).toBeTruthy();
    expect(within(line1).getByText('Ada Instructor')).toBeTruthy();
    // 19.99 × 70% = 13.993 → 13.99 for the instructor, the rest (6.00) for the platform
    expect(within(line1).getByText('$13.99')).toBeTruthy();
    expect(within(line1).getByText('70%')).toBeTruthy();
    expect(within(line1).getByText('$6.00')).toBeTruthy();
    const line2 = screen.getByTestId('line-2');
    expect(within(line2).getAllByText('$49.99')).toHaveLength(2); // list and final
    expect(within(line2).getByText('$34.99')).toBeTruthy();
    expect(within(line2).getByText('$15.00')).toBeTruthy();
    // subtotal, total and the payment amount (no discounts)
    expect(screen.getAllByText('$69.98')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Jane Student' }).getAttribute('href')).toBe(
      `/users/${STUDENT}`,
    );
  });

  it('shows the payment ids (copyable, with a Stripe link) and the timeline', async () => {
    const { order } = seedTwoLineOrder();
    const { user } = renderWithClient(<OrderDetailView id={order.id} />);
    await screen.findByTestId('line-1');

    const session = `cs_test_${order.orderNumber}`;
    const intent = `pi_test_${order.orderNumber}`;
    expect(screen.getByText(session)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy Checkout Session id' }));
    expect(await navigator.clipboard.readText()).toBe(session);
    expect(screen.getAllByText('Copied').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('link', { name: 'Open in the Stripe dashboard' }).getAttribute('href'),
    ).toBe(`https://dashboard.stripe.com/test/payments/${intent}`);

    const timeline = within(screen.getByRole('list', { name: 'Order timeline' }));
    const items = timeline.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('Pending payment');
    expect(items[0]).toContain('Checkout');
    expect(items[1]).toContain('Pending payment → Paid');
    expect(items[1]).toContain(`Event evt_test_${order.orderNumber}`);
    expect(items[2]).toContain('Webhook checkout.session.completed');
    expect(items[2]).toContain('Applied');
  });

  it('refunds the selected lines with a reason and revokes access', async () => {
    const { store, order } = seedTwoLineOrder();
    const { user } = renderWithClient(<OrderDetailView id={order.id} />);
    await screen.findByTestId('line-1');

    const refund = screen.getByRole('button', { name: 'Refund selected lines' });
    expect((refund as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Select line 1/ }));
    expect(screen.getByText('1 selected')).toBeTruthy();
    await user.click(refund);

    const dialog = within(await screen.findByRole('dialog'));
    expect(
      dialog.getByText(/\$19\.99 goes back to the buyer \(Complete TypeScript\)/),
    ).toBeTruthy();
    await user.type(dialog.getByLabelText('Reason'), 'too short');
    await user.click(dialog.getByRole('button', { name: 'Refund' }));
    expect(await dialog.findByText('Must be at least 10 characters.')).toBeTruthy();
    await user.clear(dialog.getByLabelText('Reason'));
    await user.type(dialog.getByLabelText('Reason'), REASON);
    await user.click(dialog.getByRole('button', { name: 'Refund' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await screen.findByText('1 refund approved; access to the course was revoked.'),
    ).toBeTruthy();
    const line1 = screen.getByTestId('line-1');
    await within(line1).findByText('Approved');
    expect((within(line1).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(
      (within(screen.getByTestId('line-2')).getByRole('checkbox') as HTMLInputElement).disabled,
    ).toBe(false);
    // the refunds table shows the admin refund with its reason
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(screen.getByText('Refunded by support')).toBeTruthy();

    const enrollment = store
      .userEnrollments(STUDENT)
      .find((e) => e.courseId === FIXTURE_IDS.course)!;
    expect(enrollment.status).toBe('REVOKED');
    expect(enrollment.revokeReason).toBe('REFUND');
  });

  it('keeps the refund dialog open with the problem when the line already has a refund', async () => {
    const { order } = seedTwoLineOrder();
    server.use(
      http.post(proxy('/admin/orders/:orderId/refunds'), () =>
        problemResponse(409, 'refund_already_requested'),
      ),
    );
    const { user } = renderWithClient(<OrderDetailView id={order.id} />);
    await screen.findByTestId('line-1');
    await user.click(screen.getByRole('checkbox', { name: /Select line 2/ }));
    await user.click(screen.getByRole('button', { name: 'Refund selected lines' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), REASON);
    await user.click(dialog.getByRole('button', { name: 'Refund' }));
    expect(
      await dialog.findByText(
        'One of these lines already has a refund in progress. The order was refreshed.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('accepts a payment under review', async () => {
    const store = installCommerceStore({ viewerId: ADMIN });
    const order = seedPaymentReviewOrder(store, [FIXTURE_IDS.course]);
    const { user } = renderWithClient(<OrderDetailView id={order.id} />);

    expect(await screen.findByText(/did not match the order/)).toBeTruthy();
    expect(screen.getByText('Amount mismatch')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Accept payment' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), 'Verified the charge in the dashboard.');
    await user.click(dialog.getByRole('button', { name: 'Accept payment' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: `Order #${order.orderNumber} Paid` }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept payment' })).toBeNull();
    const timeline = within(screen.getByRole('list', { name: 'Order timeline' }));
    expect(timeline.getByText('Payment review → Paid')).toBeTruthy();
    expect(timeline.getByText('Reason: Verified the charge in the dashboard.')).toBeTruthy();
    expect(store.userEnrollments(STUDENT).map((e) => e.status)).toEqual(['ACTIVE']);
  });

  it('does not offer "Accept payment" for a paid order, and explains a stale accept', async () => {
    const { order } = seedTwoLineOrder();
    renderWithClient(<OrderDetailView id={order.id} />);
    await screen.findByTestId('line-1');
    expect(screen.queryByRole('button', { name: 'Accept payment' })).toBeNull();

    const store = installCommerceStore({ viewerId: ADMIN });
    const review = seedPaymentReviewOrder(store, [FIXTURE_IDS.course]);
    server.use(
      http.post(proxy('/admin/orders/:orderId/accept-payment'), () =>
        problemResponse(409, 'invalid_state_transition'),
      ),
    );
    const second = renderWithClient(<OrderDetailView id={review.id} />);
    await second.user.click(await screen.findByRole('button', { name: 'Accept payment' }));
    const dialog = within(await screen.findByRole('dialog'));
    await second.user.type(dialog.getByLabelText('Reason'), 'Verified the charge in Stripe.');
    await second.user.click(dialog.getByRole('button', { name: 'Accept payment' }));
    expect(
      await dialog.findByText(
        'The order changed in the meantime and no longer allows this. The page was refreshed.',
      ),
    ).toBeTruthy();
  });

  it('shows a missing order', async () => {
    installCommerceStore({ viewerId: ADMIN });
    renderWithClient(<OrderDetailView id={FIXTURE_IDS.order} />);
    expect(await screen.findByText('This order does not exist.')).toBeTruthy();
  });
});
