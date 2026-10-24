/** @vitest-environment jsdom */
import { screen, waitFor, within } from '@testing-library/react';
import { FIXTURE_IDS, fixtureId } from '@udemy/contracts/testing';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { mockCommerce } from '@/test/commerce';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { CheckoutCancel, CheckoutSuccess } from './checkout-result';

const server = setupMswServer();
const { course, course2 } = FIXTURE_IDS;

/** A store with an open (PENDING_PAYMENT) order for the cart's courses. */
function pendingOrder(courseIds: string[] = [course, course2]) {
  const store = mockCommerce(server, { cart: courseIds });
  const { orderId } = store.checkout(crypto.randomUUID(), store.quote().totals.totalAmount);
  return { store, orderId };
}

/** Counts `GET /me/orders/:id` requests. */
function countOrderPolls(orderId: string): { count: number } {
  const counter = { count: 0 };
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET' && request.url.endsWith(`/me/orders/${orderId}`)) {
      counter.count += 1;
    }
  });
  return counter;
}

describe('<CheckoutSuccess>', () => {
  it('polls until the order is PAID, then shows the courses and stops polling', async () => {
    const { store, orderId } = pendingOrder();
    const polls = countOrderPolls(orderId);
    renderWithQuery(<CheckoutSuccess orderId={orderId} pollIntervalMs={20} />);

    expect(await screen.findByTestId('checkout-pending')).toBeTruthy();
    // Still pending after a few polls.
    await waitFor(() => expect(polls.count).toBeGreaterThanOrEqual(3));
    expect(screen.getByTestId('checkout-pending')).toBeTruthy();

    store.completePayment(orderId);
    const paid = await screen.findByTestId('checkout-paid');
    expect(within(paid).getByRole('heading').textContent).toBe("You're enrolled");
    const links = await within(paid).findAllByRole('link', { name: 'Go to course' });
    // Phase 5: "Go to course" opens the course player.
    expect(links.map((link) => link.getAttribute('href')).sort()).toEqual(
      [`/learn/${FIXTURE_IDS.course}`, `/learn/${FIXTURE_IDS.course2}`].sort(),
    );
    expect(within(paid).getByRole('link', { name: 'View receipt' }).getAttribute('href')).toBe(
      `/account/orders/${orderId}/receipt`,
    );

    // Terminal: no more polls (structural check, no timing bound).
    const settled = polls.count;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(polls.count).toBeLessThanOrEqual(settled + 1);
    server.events.removeAllListeners();
  });

  it('shows an expired checkout with a way back to the cart', async () => {
    const { store, orderId } = pendingOrder();
    renderWithQuery(<CheckoutSuccess orderId={orderId} pollIntervalMs={20} />);
    await screen.findByTestId('checkout-pending');

    store.expirePayment(orderId);
    const expired = await screen.findByTestId('checkout-expired');
    expect(within(expired).getByRole('link', { name: 'Back to cart' }).getAttribute('href')).toBe(
      '/cart',
    );
  });

  it('shows a canceled checkout', async () => {
    const { store, orderId } = pendingOrder();
    store.cancelOrder(orderId);
    renderWithQuery(<CheckoutSuccess orderId={orderId} pollIntervalMs={20} />);
    expect(await screen.findByTestId('checkout-canceled')).toBeTruthy();
  });

  it('says the payment is still processing when polling gives up', async () => {
    const { orderId } = pendingOrder();
    renderWithQuery(<CheckoutSuccess orderId={orderId} pollIntervalMs={10} pollTimeoutMs={50} />);
    expect(await screen.findByTestId('checkout-processing')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View order' }).getAttribute('href')).toBe(
      `/account/orders/${orderId}`,
    );
  });

  it('is immediately done for a zero-total (already PAID) order', async () => {
    const store = mockCommerce(server);
    const order = store.seedPaidOrder(FIXTURE_IDS.student, [course]);
    renderWithQuery(<CheckoutSuccess orderId={order.id} pollIntervalMs={20} />);
    expect(await screen.findByTestId('checkout-paid')).toBeTruthy();
  });

  it('reports an unknown (or foreign) order without polling it again', async () => {
    mockCommerce(server);
    const orderId = fixtureId(0xbad);
    const polls = countOrderPolls(orderId);
    renderWithQuery(<CheckoutSuccess orderId={orderId} pollIntervalMs={10} />);
    expect((await screen.findByTestId('checkout-error')).textContent).toContain(
      'belongs to another account',
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(polls.count).toBe(1);
    server.events.removeAllListeners();
  });
});

describe('<CheckoutCancel>', () => {
  it('cancels the open order and links back to the cart', async () => {
    const { store, orderId } = pendingOrder();
    renderWithQuery(<CheckoutCancel orderId={orderId} />);

    expect(await screen.findByText(/nothing was charged/)).toBeTruthy();
    expect(store.myOrder(orderId).status).toBe('CANCELED');
    expect(screen.getByRole('link', { name: 'Back to cart' }).getAttribute('href')).toBe('/cart');
  });

  it('says so when the payment already went through', async () => {
    const { orderId } = pendingOrder();
    server.use(
      http.post(`${PROXY}/me/orders/:orderId/cancel`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'order_not_cancelable',
            status: 409,
            code: 'order_not_cancelable',
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderWithQuery(<CheckoutCancel orderId={orderId} />);
    const card = await screen.findByTestId('cancel-too-late');
    expect(within(card).getByRole('link', { name: 'See your order' }).getAttribute('href')).toBe(
      `/checkout/success?orderId=${orderId}`,
    );
  });
});
