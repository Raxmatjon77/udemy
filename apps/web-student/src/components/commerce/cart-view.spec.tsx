/** @vitest-environment jsdom */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDEMPOTENCY_KEY_HEADER } from '@udemy/contracts';
import { FIXTURE_IDS, fixtureId, makeCoupon } from '@udemy/contracts/testing';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHECKOUT_ATTEMPT_KEY } from '@/lib/commerce/checkout-attempt';
import { addToGuestCart, readGuestCart } from '@/lib/commerce/guest-cart';
import { CHECKOUT_ORIGIN, mockCommerce } from '@/test/commerce';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { CartView } from './cart-view';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
const assignLocation = vi.fn();
vi.mock('@/lib/commerce/navigation', () => ({
  assignLocation: (url: string) => assignLocation(url),
}));

const server = setupMswServer();

beforeEach(() => {
  push.mockReset();
  assignLocation.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const ALLOWED = [CHECKOUT_ORIGIN];
const { course, course2, freeCourse } = FIXTURE_IDS;

function renderCart(signedIn = true, allowedOrigins: readonly string[] = ALLOWED) {
  return renderWithQuery(<CartView signedIn={signedIn} allowedOrigins={allowedOrigins} />);
}

const lines = () => screen.findAllByTestId('cart-line');
const total = () => screen.getByTestId('cart-total').textContent;
const checkoutButton = () => screen.getByRole('button', { name: 'Checkout' });

/** Records the checkout requests' idempotency keys. */
function recordCheckoutKeys(): (string | null)[] {
  const keys: (string | null)[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && request.url.endsWith('/me/checkout')) {
      keys.push(request.headers.get(IDEMPOTENCY_KEY_HEADER));
    }
  });
  return keys;
}

beforeEach(() => server.events.removeAllListeners());

describe('guest cart', () => {
  it('lists the guest courses with their public prices and asks to log in to check out', async () => {
    const user = userEvent.setup();
    mockCommerce(server);
    addToGuestCart(course, { title: 'Complete TypeScript', slug: 'complete-typescript' });
    addToGuestCart(course2, { title: 'PostgreSQL in Depth', slug: 'postgres-in-depth' });
    renderCart(false);

    const items = await lines();
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Complete TypeScript'),
      expect.stringContaining('PostgreSQL in Depth'),
    ]);
    await waitFor(() => expect(total()).toBe('$69.98'));
    expect(within(items[0]!).getByText('$19.99')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Log in to check out' }).getAttribute('href')).toBe(
      '/login?next=%2Fcart',
    );

    await user.click(screen.getByRole('button', { name: 'Remove PostgreSQL in Depth' }));
    expect(readGuestCart()).toEqual([course]);
    await waitFor(() => expect(total()).toBe('$19.99'));
  });

  it('labels ids without a stored hint from the public prices, and keeps ?coupon= through login', async () => {
    mockCommerce(server);
    addToGuestCart(course2);
    renderWithQuery(<CartView signedIn={false} allowedOrigins={ALLOWED} couponCode="LAUNCH50" />);

    const [line] = await lines();
    await waitFor(() =>
      expect(
        within(line!).getByRole('link', { name: 'PostgreSQL in Depth' }).getAttribute('href'),
      ).toBe('/course/postgres-in-depth'),
    );
    expect(screen.getByText('LAUNCH50')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Log in to check out' }).getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent('/cart?coupon=LAUNCH50')}`,
    );
  });

  it('shows an empty cart', () => {
    renderCart(false);
    expect(screen.getByText('Your cart is empty')).toBeTruthy();
  });
});

describe('server cart', () => {
  it('prefills the coupon field from ?coupon= without applying it', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, {
      cart: [course],
      coupons: [
        makeCoupon({
          courseId: course,
          code: 'LAUNCH50',
          percentOff: 50,
          startsAt: '2026-10-01T00:00:00.000Z',
          endsAt: '2026-10-30T00:00:00.000Z',
        }),
      ],
    });
    renderWithQuery(<CartView signedIn allowedOrigins={ALLOWED} couponCode="LAUNCH50" />);

    expect(await lines()).toHaveLength(1);
    expect((screen.getByLabelText('Coupon code') as HTMLInputElement).value).toBe('LAUNCH50');
    expect(store.quote().coupon).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(total()).toBe('$9.99'));
    expect(screen.getByText(/is applied/)).toBeTruthy();
  });

  it('shows lines, the totals and removes items', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, { cart: [course, course2] });
    renderCart();

    expect(await lines()).toHaveLength(2);
    expect(total()).toBe('$69.98');
    await user.click(screen.getByRole('button', { name: 'Remove PostgreSQL in Depth' }));
    await waitFor(() => expect(total()).toBe('$19.99'));
    expect(store.quote().lines.map((line) => line.courseId)).toEqual([course]);
  });

  it('lists unavailable items with the reason and blocks checkout until they are removed', async () => {
    const store = mockCommerce(server, { cart: [course, course2] });
    store.courses.get(course2)!.price = null;
    renderCart();

    const unavailable = await screen.findByTestId('cart-unavailable');
    expect(unavailable.textContent).toContain('PostgreSQL in Depth');
    expect(unavailable.textContent).toContain('Not available: not for sale');
    expect((checkoutButton() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('coupons', () => {
  it('applies a code: the line shows list price, discount and final price', async () => {
    const user = userEvent.setup();
    mockCommerce(server, { cart: [course, course2], coupons: [makeCoupon()] });
    renderCart();
    await lines();

    await user.type(screen.getByLabelText('Coupon code'), ' launch50 ');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('is applied')).toBeTruthy();
    const discounted = screen.getAllByTestId('cart-line')[0]!;
    expect(within(discounted).getByTestId('line-list').textContent).toBe('$19.99');
    expect(within(discounted).getByTestId('line-discount').textContent).toBe('-$10.00');
    expect(within(discounted).getByTestId('line-final').textContent).toBe('$9.99');
    expect(screen.getByTestId('cart-totals').textContent).toContain('-$10.00');
    expect(total()).toBe('$59.98');

    await user.click(screen.getByRole('button', { name: 'Remove code LAUNCH50' }));
    await waitFor(() => expect(total()).toBe('$69.98'));
    expect(screen.getByLabelText('Coupon code')).toBeTruthy();
  });

  it.each([
    ['an unknown code', 'NOPE1234', [], 'This code is not valid for the courses in your cart.'],
    [
      'an expired code',
      'OLDCODE',
      [makeCoupon({ code: 'OLDCODE', endsAt: '2026-10-12T00:00:00.000Z' })],
      'This code has expired.',
    ],
    [
      'a code that has not started',
      'SOON',
      [makeCoupon({ code: 'SOON', startsAt: '2026-10-20T00:00:00.000Z' })],
      'This code is not active yet.',
    ],
    [
      'a used-up code',
      'GONE',
      [makeCoupon({ code: 'GONE', maxRedemptions: 1, redemptions: { reserved: 0, consumed: 1 } })],
      'This code has been used up.',
    ],
  ])('explains %s inline', async (_name, code, coupons, message) => {
    const user = userEvent.setup();
    mockCommerce(server, { cart: [course], coupons });
    renderCart();
    await lines();

    const input = screen.getByLabelText('Coupon code');
    await user.type(input, code);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(total()).toBe('$19.99');
  });

  it('explains a code the user already redeemed', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, {
      cart: [course],
      coupons: [makeCoupon({ scope: 'PLATFORM' })],
    });
    store.applyCoupon('LAUNCH50');
    const first = store.checkout(crypto.randomUUID(), store.quote().totals.totalAmount);
    store.completePayment(first.orderId);
    store.addToCart(course2);
    renderCart();
    await lines();

    await user.type(screen.getByLabelText('Coupon code'), 'LAUNCH50');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toBe('You have already used this code.');
  });

  it('checks the code format before asking the API', async () => {
    const user = userEvent.setup();
    mockCommerce(server, { cart: [course] });
    let applied = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/me/cart/coupon')) applied += 1;
    });
    renderCart();
    await lines();
    await user.type(screen.getByLabelText('Coupon code'), 'ab');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/4–20 letters/);
    expect(applied).toBe(0);
  });

  it('shows the wait on a rate-limited apply', async () => {
    const user = userEvent.setup();
    mockCommerce(server, { cart: [course] });
    server.use(
      http.put(`${PROXY}/me/cart/coupon`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'rate_limited', status: 429, code: 'rate_limited' },
          {
            status: 429,
            headers: { 'content-type': 'application/problem+json', 'retry-after': '120' },
          },
        ),
      ),
    );
    renderCart();
    await lines();
    await user.type(screen.getByLabelText('Coupon code'), 'LAUNCH50');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many code attempts. Try again in about 2 minutes.',
    );
  });
});

describe('checkout', () => {
  it('sends an idempotency key and redirects to an allowed checkout origin', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, { cart: [course] });
    const keys = recordCheckoutKeys();
    renderCart();
    await lines();

    await user.click(checkoutButton());
    await waitFor(() => expect(assignLocation).toHaveBeenCalledTimes(1));
    const url = assignLocation.mock.calls[0]![0] as string;
    expect(new URL(url).origin).toBe(CHECKOUT_ORIGIN);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(store.myOrders()).toMatchObject([{ status: 'PENDING_PAYMENT' }]);
    // A successful attempt drops its key.
    expect(window.sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();
  });

  it('refuses to follow a checkout URL on an origin that is not allowed', async () => {
    const user = userEvent.setup();
    mockCommerce(server, { cart: [course], checkoutOrigin: 'https://checkout.evil.example' });
    renderCart();
    await lines();

    await user.click(checkoutButton());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'We could not open the payment page',
    );
    expect(assignLocation).not.toHaveBeenCalled();
  });

  it('retries a failed attempt with the same idempotency key', async () => {
    const user = userEvent.setup();
    mockCommerce(server, { cart: [course] });
    const keys = recordCheckoutKeys();
    server.use(
      http.post(
        `${PROXY}/me/checkout`,
        () =>
          HttpResponse.json(
            {
              type: 'about:blank',
              title: 'payment_provider_unavailable',
              status: 503,
              code: 'payment_provider_unavailable',
            },
            { status: 503, headers: { 'content-type': 'application/problem+json' } },
          ),
        { once: true },
      ),
    );
    renderCart();
    await lines();

    await user.click(checkoutButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/payment service/);
    await user.click(checkoutButton());
    await waitFor(() => expect(assignLocation).toHaveBeenCalledTimes(1));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('offers to resume a checkout in progress', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, { cart: [course] });
    const open = store.checkout(crypto.randomUUID(), '19.99');
    renderCart();
    await lines();

    await user.click(checkoutButton());
    const dialog = await screen.findByRole('dialog', { name: 'You have a checkout in progress' });
    await user.click(within(dialog).getByRole('button', { name: 'Resume payment' }));
    expect(assignLocation).toHaveBeenCalledWith(open.checkoutUrl);
    expect(store.myOrders()).toHaveLength(1);
  });

  it('cancels the checkout in progress and starts over', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, { cart: [course] });
    const open = store.checkout(crypto.randomUUID(), '19.99');
    renderCart();
    await lines();

    await user.click(checkoutButton());
    const dialog = await screen.findByRole('dialog', { name: 'You have a checkout in progress' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel and start over' }));

    await waitFor(() => expect(assignLocation).toHaveBeenCalledTimes(1));
    expect(assignLocation.mock.calls[0]![0]).not.toBe(open.checkoutUrl);
    expect(store.myOrders().map((order) => order.status)).toEqual(['PENDING_PAYMENT', 'CANCELED']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the new quote when the price changed since the cart was loaded', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, { cart: [course] });
    renderCart();
    await lines();
    expect(total()).toBe('$19.99');

    store.courses.get(course)!.price = '24.99';
    await user.click(checkoutButton());

    expect((await screen.findByRole('status')).textContent).toContain(
      'Prices in your cart have changed',
    );
    expect(total()).toBe('$24.99');
    expect(assignLocation).not.toHaveBeenCalled();
    expect(store.myOrders()).toEqual([]);

    // Checking out again with the new total goes through.
    await user.click(checkoutButton());
    await waitFor(() => expect(assignLocation).toHaveBeenCalledTimes(1));
  });

  it('shows the new quote when an item became unavailable (cart_changed)', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, { cart: [course, course2] });
    renderCart();
    await lines();

    store.courses.get(course2)!.status = 'ARCHIVED';
    await user.click(checkoutButton());
    expect((await screen.findByRole('status')).textContent).toContain('Your cart has changed');
    expect(await screen.findByTestId('cart-unavailable')).toBeTruthy();
  });

  it('completes a zero-total order without the payment page', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, {
      cart: [course],
      coupons: [makeCoupon({ code: 'FREEBIE', percentOff: 100 })],
    });
    store.applyCoupon('FREEBIE');
    renderCart();
    await lines();
    expect(total()).toBe('$0.00');

    await user.click(checkoutButton());
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const [order] = store.myOrders();
    expect(order).toMatchObject({ status: 'PAID', totalAmount: '0.00' });
    expect(push).toHaveBeenCalledWith(`/checkout/success?orderId=${order!.id}`);
    expect(assignLocation).not.toHaveBeenCalled();
  });

  it('asks to verify the email address first', async () => {
    const user = userEvent.setup();
    mockCommerce(server, { cart: [course], emailVerified: false });
    renderCart();
    await lines();

    await user.click(checkoutButton());
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Verify your email address');
    expect(
      within(notice)
        .getByRole('link', { name: 'Resend the verification link' })
        .getAttribute('href'),
    ).toBe('/verify-email/pending');
  });

  it('explains a total below the minimum charge', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server, {
      cart: [course],
      coupons: [makeCoupon({ code: 'ALMOST', discountType: 'AMOUNT', amountOff: '19.70' })],
    });
    store.applyCoupon('ALMOST');
    renderCart();
    await lines();
    expect(total()).toBe('$0.29');

    await user.click(checkoutButton());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Card payments must be at least $0.50. Add another course or remove the code to continue.',
    );
    expect(window.sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();
  });

  it('reports a free or deleted course in the server cart as unavailable', async () => {
    mockCommerce(server, { cart: [freeCourse, fixtureId(0xdead)] });
    renderCart();
    expect(await screen.findAllByTestId('cart-unavailable')).toHaveLength(2);
  });
});
