// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOrderPageSchema, AdminUserPageSchema } from '@udemy/contracts';
import { FIXTURE_IDS, fixtureId, makeAdminOrderRow } from '@udemy/contracts/testing';

import { ADMIN, STUDENT } from '@/test/commerce';
import { installCommerceStore, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { OrdersSearch } from './orders-search';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

setupMockApi();
beforeEach(() => push.mockReset());
afterEach(() => server.events.removeAllListeners());

const rowOf = (text: string) => screen.getByText(text).closest('tr')!;

describe('<OrdersSearch>', () => {
  it('lists orders with the buyer, status badge and formatted total', async () => {
    const store = installCommerceStore({ viewerId: ADMIN });
    const first = store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course]);
    const second = store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course, FIXTURE_IDS.course2]);
    renderWithClient(<OrdersSearch filters={{}} />);

    const newest = await screen
      .findByText(`#${second.orderNumber}`)
      .then((el) => el.closest('tr')!);
    expect(within(newest).getByText('$69.98')).toBeTruthy();
    expect(within(newest).getByText('2 courses')).toBeTruthy();
    expect(within(newest).getByText('jane@example.com')).toBeTruthy();
    expect(within(newest).getByText('Paid')).toBeTruthy();
    expect(
      within(newest)
        .getByRole('link', { name: `#${second.orderNumber}` })
        .getAttribute('href'),
    ).toBe(`/orders/${second.id}`);
    expect(within(rowOf(`#${first.orderNumber}`)).getByText('$19.99')).toBeTruthy();
    // newest first
    const links = screen.getAllByRole('link', { name: /^#\d+$/ }).map((a) => a.textContent);
    expect(links).toEqual([`#${second.orderNumber}`, `#${first.orderNumber}`]);
    expect(screen.getByRole('status').textContent).toBe('Showing 2 orders (all)');
  });

  it('sends the filters to the API and shows an empty result', async () => {
    const store = installCommerceStore({ viewerId: ADMIN });
    const paid = store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course]);
    const queries: URLSearchParams[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/proxy/admin/orders') queries.push(url.searchParams);
    });
    renderWithClient(
      <OrdersSearch
        filters={{
          q: paid.orderNumber,
          status: 'REFUNDED',
          userId: STUDENT,
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-10-11T00:00:00.000Z',
        }}
      />,
    );
    expect(await screen.findByText('No orders match these filters.')).toBeTruthy();
    const query = queries.at(-1)!;
    expect(query.get('q')).toBe(String(paid.orderNumber));
    expect(query.get('status')).toBe('REFUNDED');
    expect(query.get('userId')).toBe(STUDENT);
    expect(query.get('from')).toBe('2026-10-01T00:00:00.000Z');
    expect(query.get('to')).toBe('2026-10-11T00:00:00.000Z');
    // the form is prefilled from the filters; the "to" day is inclusive
    expect((screen.getByLabelText('Order number') as HTMLInputElement).value).toBe(
      String(paid.orderNumber),
    );
    expect((screen.getByLabelText('Placed until (UTC)') as HTMLInputElement).value).toBe(
      '2026-10-10',
    );
  });

  it('pages with the keyset cursor', async () => {
    const page1 = [1, 2].map((n) =>
      makeAdminOrderRow({ id: fixtureId(0x9000 + n), orderNumber: 2000 - n }),
    );
    const page2 = [makeAdminOrderRow({ id: fixtureId(0x9003), orderNumber: 1997 })];
    const cursors: (string | null)[] = [];
    server.use(
      http.get(proxy('/admin/orders'), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(
          AdminOrderPageSchema.parse(
            cursor === null
              ? { items: page1, nextCursor: 'cursor-2' }
              : { items: page2, nextCursor: null },
          ),
        );
      }),
    );
    const { user } = renderWithClient(<OrdersSearch filters={{}} />);

    await screen.findByText('#1999');
    expect(screen.getByRole('status').textContent).toBe('Showing 2 orders');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('#1997');
    expect(screen.getByRole('status').textContent).toBe('Showing 3 orders (all)');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(cursors).toEqual([null, 'cursor-2']);
  });

  it('builds the search URL from the form, a picked buyer and the dates', async () => {
    installCommerceStore({ viewerId: ADMIN });
    server.use(
      http.get(proxy('/admin/users'), ({ request }) => {
        expect(new URL(request.url).searchParams.get('q')).toBe('jane');
        return HttpResponse.json(
          AdminUserPageSchema.parse({
            items: [
              {
                id: STUDENT,
                email: 'jane@example.com',
                displayName: 'Jane Student',
                emailVerified: true,
                roles: ['STUDENT'],
                status: 'ACTIVE',
                createdAt: '2026-09-01T00:00:00.000Z',
              },
            ],
            nextCursor: null,
          }),
        );
      }),
    );
    const { user } = renderWithClient(<OrdersSearch filters={{}} />);
    await screen.findByText('No orders match these filters.');

    await user.type(screen.getByLabelText('Order number'), '#1042');
    await user.selectOptions(screen.getByLabelText('Status'), 'PAYMENT_REVIEW');
    await user.type(screen.getByLabelText('Placed from (UTC)'), '2026-10-01');
    await user.type(screen.getByLabelText('Placed until (UTC)'), '2026-10-09');
    await user.type(screen.getByLabelText('Buyer'), 'jane');
    await user.click(screen.getByRole('button', { name: 'Search Buyer' }));
    await user.click(await screen.findByRole('button', { name: /Jane Student/ }));
    expect(screen.getByRole('group', { name: 'Buyer' }).textContent).toContain('Jane Student');

    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(push).toHaveBeenCalledWith(
      `/orders?q=1042&status=PAYMENT_REVIEW&from=2026-10-01&to=2026-10-09&userId=${STUDENT}`,
    );
  });

  it('searches by a part of the buyer email', async () => {
    const store = installCommerceStore({ viewerId: ADMIN });
    const order = store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course]);
    store.seedPaidOrder(ADMIN, [FIXTURE_IDS.course2]);
    const { user } = renderWithClient(<OrdersSearch filters={{ buyerEmail: 'JANE@' }} />);

    // the API matches case-insensitively: only the student's order
    await screen.findByText(`#${order.orderNumber}`);
    expect(screen.getAllByRole('link', { name: /^#\d+$/ })).toHaveLength(1);
    const field = screen.getByLabelText('Buyer email contains') as HTMLInputElement;
    expect(field.value).toBe('JANE@');

    await user.clear(field);
    await user.type(field, 'ja');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Enter at least 3 characters of the email.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    await user.type(field, 'ne@');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(push).toHaveBeenCalledWith('/orders?buyerEmail=jane%40');
  });

  it('rejects a bad order number and an inverted date range', async () => {
    installCommerceStore({ viewerId: ADMIN });
    const { user } = renderWithClient(<OrdersSearch filters={{}} />);
    await screen.findByText('No orders match these filters.');
    await user.type(screen.getByLabelText('Order number'), 'abc');
    await user.type(screen.getByLabelText('Placed from (UTC)'), '2026-10-09');
    await user.type(screen.getByLabelText('Placed until (UTC)'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Enter an order number, e.g. 1042.')).toBeTruthy();
    expect(screen.getByText('The end date must not be before the start date.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('shows an API error with a retry', async () => {
    server.use(
      http.get(proxy('/admin/orders'), () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'x', status: 503, code: 'service_unavailable' },
          { status: 503, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderWithClient(<OrdersSearch filters={{}} />);
    expect(
      await screen.findByText(
        'The service is temporarily unavailable. Please try again in a moment.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
