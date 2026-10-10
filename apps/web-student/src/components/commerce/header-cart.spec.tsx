/** @vitest-environment jsdom */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_IDS } from '@udemy/contracts/testing';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  addToGuestCart,
  GUEST_CART_KEY,
  readGuestCart,
  removeFromGuestCart,
} from '@/lib/commerce/guest-cart';
import { mockCommerce } from '@/test/commerce';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { HeaderCart } from './header-cart';

const server = setupMswServer();

beforeEach(() => window.localStorage.clear());

const cartLink = () => screen.getByRole('link', { name: /^Cart/ });

describe('<HeaderCart> signed out', () => {
  it('counts the guest cart in localStorage and follows changes', async () => {
    addToGuestCart(FIXTURE_IDS.course);
    addToGuestCart(FIXTURE_IDS.course2);
    renderWithQuery(<HeaderCart signedIn={false} />);

    expect(cartLink().getAttribute('aria-label')).toBe('Cart, 2 items');
    expect(cartLink().getAttribute('href')).toBe('/cart');
    expect(screen.getByTestId('cart-count').textContent).toBe('2');

    act(() => removeFromGuestCart(FIXTURE_IDS.course2));
    expect(cartLink().getAttribute('aria-label')).toBe('Cart, 1 item');

    act(() => removeFromGuestCart(FIXTURE_IDS.course));
    expect(cartLink().getAttribute('aria-label')).toBe('Cart');
    expect(screen.queryByTestId('cart-count')).toBeNull();
  });

  it('ignores a tampered guest cart', () => {
    window.localStorage.setItem(GUEST_CART_KEY, JSON.stringify(['not-a-uuid', 42]));
    renderWithQuery(<HeaderCart signedIn={false} />);
    expect(cartLink().getAttribute('aria-label')).toBe('Cart');
    expect(readGuestCart()).toEqual([]);
  });
});

describe('<HeaderCart> signed in', () => {
  it('shows the server cart count', async () => {
    mockCommerce(server, { cart: [FIXTURE_IDS.course, FIXTURE_IDS.course2] });
    renderWithQuery(<HeaderCart signedIn />);
    await waitFor(() => expect(cartLink().getAttribute('aria-label')).toBe('Cart, 2 items'));
  });

  it('merges the guest cart once after login, clears it and reports the skipped items', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    store.seedPaidOrder(FIXTURE_IDS.student, [FIXTURE_IDS.course2]);
    addToGuestCart(FIXTURE_IDS.course, {
      title: 'Complete TypeScript',
      slug: 'complete-typescript',
    });
    addToGuestCart(FIXTURE_IDS.course2, {
      title: 'PostgreSQL in Depth',
      slug: 'postgres-in-depth',
    });
    addToGuestCart(FIXTURE_IDS.freeCourse, { title: 'Git Basics', slug: 'git-basics' });
    let merges = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/me/cart/merge')) merges += 1;
    });

    renderWithQuery(<HeaderCart signedIn />);

    const notice = await screen.findByTestId('merge-notice');
    expect(notice.textContent).toBe(
      "2 items couldn't be added to your cart: PostgreSQL in Depth (already enrolled), Git Basics (free, enroll from its page).",
    );
    expect(readGuestCart()).toEqual([]);
    expect(store.quote().lines.map((line) => line.courseId)).toEqual([FIXTURE_IDS.course]);
    await waitFor(() => expect(cartLink().getAttribute('aria-label')).toBe('Cart, 1 item'));
    expect(merges).toBe(1);
    server.events.removeAllListeners();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('merge-notice')).toBeNull();
  });

  it('keeps the guest cart for a later try when the merge fails on the server side', async () => {
    mockCommerce(server);
    server.use(http.post(`${PROXY}/me/cart/merge`, () => new HttpResponse(null, { status: 503 })));
    addToGuestCart(FIXTURE_IDS.course);
    renderWithQuery(<HeaderCart signedIn />);
    await waitFor(() => expect(cartLink().getAttribute('aria-label')).toBe('Cart'));
    expect(readGuestCart()).toEqual([FIXTURE_IDS.course]);
    expect(screen.queryByTestId('merge-notice')).toBeNull();
  });

  it('drops the guest cart with a notice when the server cart is full', async () => {
    mockCommerce(server);
    server.use(
      http.post(`${PROXY}/me/cart/merge`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'cart_full', status: 422, code: 'cart_full' },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    addToGuestCart(FIXTURE_IDS.course);
    renderWithQuery(<HeaderCart signedIn />);
    expect((await screen.findByTestId('merge-notice')).textContent).toMatch(/cart is full/);
    expect(readGuestCart()).toEqual([]);
  });
});
