/** @vitest-environment jsdom */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_IDS, type CommerceMockStore } from '@udemy/contracts/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readGuestCart } from '@/lib/commerce/guest-cart';
import { mockCommerce } from '@/test/commerce';
import { setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { PurchaseBox, purchaseBoxState } from './purchase-box';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const server = setupMswServer();

beforeEach(() => {
  push.mockReset();
  window.localStorage.clear();
});

const PAID = { id: FIXTURE_IDS.course, slug: 'complete-typescript', title: 'Complete TypeScript' };
const FREE = { id: FIXTURE_IDS.freeCourse, slug: 'git-basics', title: 'Git Basics' };

function priceOf(store: CommerceMockStore, courseId: string) {
  return store.publicPrices([courseId])[0] ?? null;
}

function renderBox(
  store: CommerceMockStore,
  course: typeof PAID,
  signedIn: boolean,
  price = priceOf(store, course.id),
) {
  return renderWithQuery(<PurchaseBox course={course} price={price} signedIn={signedIn} />);
}

const box = () => screen.getByTestId('purchase-box');
const stateOf = async (state: string) => waitFor(() => expect(box().dataset.state).toBe(state));

describe('purchaseBoxState', () => {
  const price = {
    courseId: PAID.id,
    amount: '19.99',
    currency: 'USD',
    isFree: false,
    slug: PAID.slug,
    title: PAID.title,
  } as const;
  const state = {
    courseId: PAID.id,
    enrolled: false,
    inCart: false,
    isOwner: false,
    forSale: true,
  };

  it('puts the owner and enrolled students before the price, then not-for-sale and free', () => {
    expect(
      purchaseBoxState({ price: null, purchase: { ...state, isOwner: true }, inGuestCart: false }),
    ).toBe('owner');
    expect(
      purchaseBoxState({ price: null, purchase: { ...state, enrolled: true }, inGuestCart: false }),
    ).toBe('enrolled');
    expect(purchaseBoxState({ price: null, purchase: state, inGuestCart: false })).toBe(
      'not_for_sale',
    );
    expect(
      purchaseBoxState({
        price: { ...price, amount: '0.00', isFree: true },
        purchase: null,
        inGuestCart: true,
      }),
    ).toBe('free');
  });

  it('lets the live purchase state say "not for sale" over a stale server price', () => {
    expect(
      purchaseBoxState({ price, purchase: { ...state, forSale: false }, inGuestCart: false }),
    ).toBe('not_for_sale');
    expect(
      purchaseBoxState({
        price,
        purchase: { ...state, forSale: false, enrolled: true },
        inGuestCart: false,
      }),
    ).toBe('enrolled');
  });

  it('uses the server cart when signed in and the guest cart otherwise', () => {
    expect(purchaseBoxState({ price, purchase: state, inGuestCart: true })).toBe('add_to_cart');
    expect(
      purchaseBoxState({ price, purchase: { ...state, inCart: true }, inGuestCart: false }),
    ).toBe('in_cart');
    expect(purchaseBoxState({ price, purchase: null, inGuestCart: true })).toBe('in_cart');
    expect(purchaseBoxState({ price, purchase: null, inGuestCart: false })).toBe('add_to_cart');
  });
});

describe('<PurchaseBox> signed out', () => {
  it('adds a paid course to the guest cart, then offers "Go to cart"', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    renderBox(store, PAID, false);

    expect(box().dataset.state).toBe('add_to_cart');
    expect(screen.getByTestId('price').textContent).toBe('$19.99');
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));

    expect(readGuestCart()).toEqual([PAID.id]);
    await stateOf('in_cart');
    expect(screen.getByRole('link', { name: 'Go to cart' }).getAttribute('href')).toBe('/cart');
  });

  it('"Buy now" adds to the guest cart and opens the cart', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    renderBox(store, PAID, false);
    await user.click(screen.getByRole('button', { name: 'Buy now' }));
    expect(readGuestCart()).toEqual([PAID.id]);
    expect(push).toHaveBeenCalledWith('/cart');
  });

  it('sends a visitor who wants a free course to the login page first', () => {
    const store = mockCommerce(server);
    renderBox(store, FREE, false);
    expect(box().dataset.state).toBe('free');
    expect(screen.getByTestId('price').textContent).toBe('Free');
    expect(screen.getByRole('link', { name: 'Enroll for free' }).getAttribute('href')).toBe(
      '/login?next=%2Fcourse%2Fgit-basics',
    );
  });

  it('says "not for sale" for a course without a price', () => {
    const store = mockCommerce(server);
    renderBox(store, PAID, false, null);
    expect(box().dataset.state).toBe('not_for_sale');
    expect(screen.getByTestId('price').textContent).toBe('Not available yet');
    const button = screen.getByRole('button', { name: 'Not available for enrollment yet' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('<PurchaseBox> signed in', () => {
  it('adds to the server cart and switches to "Go to cart"', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    renderBox(store, PAID, true);

    await stateOf('add_to_cart');
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));
    await stateOf('in_cart');
    expect(store.quote().lines.map((line) => line.courseId)).toEqual([PAID.id]);
    expect(readGuestCart()).toEqual([]);
  });

  it('shows "in cart" from the purchase states', async () => {
    const store = mockCommerce(server, { cart: [PAID.id] });
    renderBox(store, PAID, true);
    await stateOf('in_cart');
  });

  it('shows "Go to course" to an enrolled student', async () => {
    const store = mockCommerce(server);
    store.seedPaidOrder(FIXTURE_IDS.student, [PAID.id]);
    renderBox(store, PAID, true);
    await stateOf('enrolled');
    expect(screen.queryByTestId('price')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to course' }).getAttribute('href')).toBe(
      `/learn/${PAID.id}`,
    );
  });

  it('tells the instructor it is their own course', async () => {
    const store = mockCommerce(server, { viewerId: FIXTURE_IDS.instructor });
    renderBox(store, PAID, true);
    await stateOf('owner');
    expect(screen.getByText("You're the instructor")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();
  });

  it('enrolls in a free course and goes to it', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    renderBox(store, FREE, true);

    await stateOf('free');
    await user.click(screen.getByRole('button', { name: 'Enroll for free' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/learn/${FIXTURE_IDS.freeCourse}`));
    expect(store.myLearning().map((card) => card.courseId)).toEqual([FREE.id]);
    await stateOf('enrolled');
  });

  it('explains a refused add (the course stopped being for sale) and refreshes the state', async () => {
    const user = userEvent.setup();
    const store = mockCommerce(server);
    renderBox(store, PAID, true);
    await stateOf('add_to_cart');

    store.courses.get(PAID.id)!.price = null;
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This course is not available for purchase yet.',
    );
  });
});
