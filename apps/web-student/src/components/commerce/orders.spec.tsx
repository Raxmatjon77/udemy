/** @vitest-environment jsdom */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_IDS, fixtureId } from '@udemy/contracts/testing';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clock, CHECKOUT_ORIGIN, mockCommerce } from '@/test/commerce';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { OrderDetailView, OrdersList } from './orders';
import { ReceiptView } from './receipt-view';

const assignLocation = vi.fn();
vi.mock('@/lib/commerce/navigation', () => ({
  assignLocation: (url: string) => assignLocation(url),
}));

const server = setupMswServer();
const { student, course, course2 } = FIXTURE_IDS;
const START = clock.now;

afterEach(() => {
  clock.now = START;
  assignLocation.mockReset();
});

function renderDetail(orderId: string) {
  return renderWithQuery(<OrderDetailView orderId={orderId} allowedOrigins={[CHECKOUT_ORIGIN]} />);
}

const lineOf = async (title: string) =>
  (await screen.findAllByTestId('order-line')).find((line) => line.textContent?.includes(title))!;

function problem(status: number, code: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: code, status, code },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('<OrdersList>', () => {
  it('lists the orders, newest first, with status and total', async () => {
    const store = mockCommerce(server);
    const first = store.seedPaidOrder(student, [course]);
    const second = store.seedPaidOrder(student, [course2]);
    renderWithQuery(<OrdersList />);

    const rows = await screen.findAllByTestId('order-row');
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
      `Order #${second.orderNumber}`,
      `Order #${first.orderNumber}`,
    ]);
    expect(rows[1]!.textContent).toContain('Complete TypeScript');
    expect(rows[1]!.textContent).toContain('$19.99');
    expect(within(rows[1]!).getByTestId('order-status').textContent).toBe('Paid');
    expect(within(rows[1]!).getByRole('link').getAttribute('href')).toBe(
      `/account/orders/${first.id}`,
    );
  });

  it('shows an empty state', async () => {
    mockCommerce(server);
    renderWithQuery(<OrdersList />);
    expect(await screen.findByText('No orders yet')).toBeTruthy();
  });
});

describe('<OrderDetailView>', () => {
  it('shows the lines, the totals, the refund window and the receipt link', async () => {
    const store = mockCommerce(server);
    const order = store.seedPaidOrder(student, [course, course2]);
    renderDetail(order.id);

    expect(
      await screen.findByRole('heading', { name: `Order #${order.orderNumber}` }),
    ).toBeTruthy();
    const line = await lineOf('Complete TypeScript');
    expect(line.textContent).toContain('$19.99');
    expect(within(line).getByText(/Refundable until/).textContent).toBe(
      'Refundable until Nov 14, 2026',
    );
    // Original price and total (no coupon).
    expect(screen.getAllByText('$69.98')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'View receipt' }).getAttribute('href')).toBe(
      `/account/orders/${order.id}/receipt`,
    );
  });

  it('requests a refund for one line: approved at once, access ends', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    const order = store.seedPaidOrder(student, [course, course2]);
    renderDetail(order.id);

    const line = await lineOf('Complete TypeScript');
    await user.click(within(line).getByRole('button', { name: 'Request refund' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request a refund' });
    expect(within(dialog).getByText(/Refunds are possible until Nov 14, 2026/)).toBeTruthy();

    // The reason list is exactly the student reasons.
    const reason = within(dialog).getByLabelText('Reason');
    expect(
      within(reason)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['', 'NOT_AS_EXPECTED', 'QUALITY', 'ACCIDENTAL_PURCHASE', 'OTHER']);

    // A reason is required.
    await user.click(within(dialog).getByRole('button', { name: 'Request refund' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeTruthy();

    await user.selectOptions(reason, 'QUALITY');
    await user.type(within(dialog).getByLabelText('Comment'), 'Audio is too quiet');
    await user.click(within(dialog).getByRole('button', { name: 'Request refund' }));

    expect((await screen.findByRole('status')).textContent).toContain(
      'Your refund for "Complete TypeScript" is approved',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(async () =>
      expect(
        within(await lineOf('Complete TypeScript')).getByTestId('refund-status').textContent,
      ).toBe('Refund approved, processing'),
    );
    expect(store.myLearning().map((card) => card.courseId)).toEqual([course2]);
    // The other line is still refundable.
    expect(
      within(await lineOf('PostgreSQL in Depth')).getByRole('button', { name: 'Request refund' }),
    ).toBeTruthy();
  });

  it('says "under review" when the request needs an admin decision', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    // Three recent refunds send the next request to review (D11).
    for (const id of [course, course2, FIXTURE_IDS.course]) {
      const earlier = store.seedPaidOrder(student, [id]);
      store.requestRefund(earlier.id, { orderLineId: earlier.lines[0]!.id, reasonCode: 'OTHER' });
    }
    const order = store.seedPaidOrder(student, [course2]);
    renderDetail(order.id);

    await user.click(
      within(await lineOf('PostgreSQL in Depth')).getByRole('button', { name: 'Request refund' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'NOT_AS_EXPECTED');
    await user.click(within(dialog).getByRole('button', { name: 'Request refund' }));
    expect((await screen.findByRole('status')).textContent).toContain('is under review');
  });

  it.each([
    ['refund_window_closed', 422, 'The refund window for this course has closed.'],
    ['refund_already_requested', 409, 'A refund has already been requested for this course.'],
    ['refund_not_applicable', 422, 'This purchase cannot be refunded.'],
    ['rate_limited', 429, /several refund requests today/],
  ])('maps %s in the dialog', async (code, status, message) => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    const order = store.seedPaidOrder(student, [course]);
    server.use(http.post(`${PROXY}/me/orders/:orderId/refunds`, () => problem(status, code)));
    renderDetail(order.id);

    await user.click(
      within(await lineOf('Complete TypeScript')).getByRole('button', { name: 'Request refund' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'ACCIDENTAL_PURCHASE');
    await user.click(within(dialog).getByRole('button', { name: 'Request refund' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(message);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('explains why a line can no longer be refunded', async () => {
    const store = mockCommerce(server);
    const order = store.seedPaidOrder(student, [course]);
    clock.now = new Date(START.getTime() + 31 * 24 * 60 * 60 * 1000);
    renderDetail(order.id);

    const line = await lineOf('Complete TypeScript');
    expect(within(line).queryByRole('button', { name: 'Request refund' })).toBeNull();
    expect(within(line).getByTestId('refund-blocked').textContent).toBe(
      'The refund window closed on Nov 14, 2026.',
    );
  });

  it('offers to resume or cancel an order awaiting payment', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, { cart: [course] });
    const open = store.checkout(crypto.randomUUID(), '19.99');
    renderDetail(open.orderId);

    await user.click(await screen.findByRole('button', { name: 'Resume payment' }));
    expect(assignLocation).toHaveBeenCalledWith(open.checkoutUrl);

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect((await screen.findByRole('status')).textContent).toContain('The order was canceled');
    expect(store.myOrder(open.orderId).status).toBe('CANCELED');
    expect(screen.queryByRole('button', { name: 'Resume payment' })).toBeNull();
  });

  it('is a not-found message for a foreign order', async () => {
    mockCommerce(server);
    renderDetail(fixtureId(0xf00));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'We could not find this order.',
    );
  });
});

describe('<ReceiptView>', () => {
  it('prints the receipt of a paid order', async () => {
    const store = mockCommerce(server);
    const order = store.seedPaidOrder(student, [course, course2]);
    renderWithQuery(<ReceiptView orderId={order.id} />);

    const receipt = await screen.findByTestId('receipt');
    expect(receipt.textContent).toContain(`#${order.orderNumber}`);
    expect(receipt.textContent).toContain('Jane Student');
    expect(within(receipt).getByTestId('receipt-total').textContent).toBe('$69.98');
    expect(within(receipt).getByRole('button', { name: 'Print receipt' })).toBeTruthy();
  });

  it('has no receipt for an unpaid order', async () => {
    const store = mockCommerce(server, { cart: [course] });
    const open = store.checkout(crypto.randomUUID(), '19.99');
    renderWithQuery(<ReceiptView orderId={open.orderId} />);
    expect((await screen.findByRole('alert')).textContent).toContain('not paid');
  });
});
