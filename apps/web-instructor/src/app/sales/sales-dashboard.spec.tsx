// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { RecentSalePageSchema } from '@udemy/contracts';
import { FIXTURE_IDS, fixtureId, makeRecentSale } from '@udemy/contracts/testing';

import { builderCourse, installCommerce } from '@/test/commerce';
import { IDS } from '@/test/fixtures';
import { proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { SalesDashboard } from './sales-dashboard';

setupMockApi();

const SECOND_COURSE = '0b1f6d1e-0000-4000-8000-0000000000c2';

/** Two courses of the instructor, three paid lines (19.99 twice, 49.99 once). */
function seededStore() {
  const store = installCommerce({
    courses: [
      builderCourse({ status: 'PUBLISHED' }),
      builderCourse({
        id: SECOND_COURSE,
        slug: 'postgres-in-depth',
        title: 'PostgreSQL in Depth',
        status: 'PUBLISHED',
        price: '49.99',
      }),
    ],
  });
  store.seedPaidOrder(FIXTURE_IDS.student, [IDS.course, SECOND_COURSE]);
  store.seedPaidOrder(FIXTURE_IDS.admin, [IDS.course]);
  return store;
}

function stat(label: string): string {
  const term = screen.getAllByRole('term').find((dt) => dt.textContent === label);
  if (!term) throw new Error(`No stat ${label}`);
  return term.nextElementSibling?.textContent ?? '';
}

describe('/sales summary', () => {
  it('shows the totals and the per-course breakdown for the default range', async () => {
    seededStore();
    renderWithClient(<SalesDashboard />);

    await waitFor(() => expect(stat('Sales')).toBe('3'));
    expect(stat('Gross')).toBe('$89.97');
    expect(stat('Refunds')).toBe('$0.00');
    expect(stat('Net')).toBe('$89.97');
    // 70 % per line, rounded half up: 13.99 + 34.99 + 13.99
    expect(stat('Your share')).toBe('$62.97');

    const table = screen.getByRole('table', { name: 'Sales per course, highest net first' });
    const [, first, second] = within(table).getAllByRole('row');
    // By net DESC: 49.99 before 2 × 19.99.
    expect(within(first!).getByText('PostgreSQL in Depth')).toBeTruthy();
    expect(within(first!).getAllByRole('cell')[5]?.textContent).toBe('$34.99');
    expect(within(second!).getByText('NestJS in practice')).toBeTruthy();
    expect(within(second!).getAllByRole('cell')[1]?.textContent).toBe('2');
    expect(within(second!).getAllByRole('cell')[5]?.textContent).toBe('$27.98');
  });

  it('refetches for an applied range and validates it', async () => {
    seededStore();
    const user = userEvent.setup();
    renderWithClient(<SalesDashboard />);
    await waitFor(() => expect(stat('Sales')).toBe('3'));

    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    fireEvent.change(from, { target: { value: '2020-02-01' } });
    fireEvent.change(to, { target: { value: '2020-01-01' } });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Must be on or after the start.')).toBeTruthy();

    fireEvent.change(to, { target: { value: '2020-02-29' } });
    await user.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(stat('Sales')).toBe('0'));
    expect(screen.getByText('No sales in this period.')).toBeTruthy();
  });
});

describe('/sales recent sales', () => {
  it('lists sales without buyer data', async () => {
    seededStore();
    renderWithClient(<SalesDashboard />);

    const table = await screen.findByRole('table', { name: 'Recent sales, newest first' });
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3 lines
    expect(table.textContent).not.toContain('jane@example.com');
    expect(table.textContent).not.toContain('Jane Student');
  });

  it('pages with the keyset cursor ("Load more")', async () => {
    installCommerce();
    const cursors: (string | null)[] = [];
    const sale = (n: number, overrides = {}) =>
      makeRecentSale({
        orderLineId: fixtureId(0x5a00 + n),
        courseTitle: `Sale ${n}`,
        ...overrides,
      });
    server.use(
      http.get(proxy('/instructor/sales'), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        const page =
          cursor === null
            ? {
                items: [sale(1), sale(2, { couponCode: 'LAUNCH50', finalAmount: '9.99' })],
                nextCursor: 'cGFnZTI',
              }
            : { items: [sale(3, { refunded: true })], nextCursor: null };
        return HttpResponse.json(RecentSalePageSchema.parse(page));
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SalesDashboard />);

    const table = await screen.findByRole('table', { name: 'Recent sales, newest first' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    const discounted = within(table).getByText('Sale 2').closest('tr')!;
    expect(within(discounted).getByText('LAUNCH50')).toBeTruthy();
    expect(within(discounted).getByText('$19.99').tagName).toBe('S');

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    const refunded = within(table).getByText('Sale 3').closest('tr')!;
    expect(within(refunded).getByText('Refunded')).toBeTruthy();
    expect(cursors).toEqual([null, 'cGFnZTI']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
