// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { Coupon } from '@udemy/contracts';
import { makeCoupon, problemResponse } from '@udemy/contracts/testing';

import { installCommerce } from '@/test/commerce';
import { categoryTree, courseDetail, curriculum, history, IDS } from '@/test/fixtures';
import { proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import type { BuilderTab } from './builder-tabs';
import { CourseBuilder } from './course-builder';

setupMockApi();

const DAY_MS = 24 * 60 * 60 * 1000;

/** The catalog GETs the builder loads (the commerce routes come from `installCommerce`). */
function catalogApi() {
  server.use(
    http.get(proxy(`/courses/${IDS.course}`), () => HttpResponse.json(courseDetail())),
    http.get(proxy(`/courses/${IDS.course}/curriculum`), () => HttpResponse.json(curriculum())),
    http.get(proxy(`/courses/${IDS.course}/history`), () => HttpResponse.json(history())),
    http.get(proxy('/catalog/categories'), () => HttpResponse.json(categoryTree())),
  );
}

function renderBuilder(initialTab: BuilderTab) {
  return renderWithClient(<CourseBuilder courseId={IDS.course} initialTab={initialTab} />);
}

/** A coupon of the builder's course, valid around the real clock (the store derives state). */
function courseCoupon(overrides: Partial<Coupon> = {}): Coupon {
  const now = Date.now();
  return makeCoupon({
    courseId: IDS.course,
    createdBy: IDS.owner,
    startsAt: new Date(now - DAY_MS).toISOString(),
    endsAt: new Date(now + 10 * DAY_MS).toISOString(),
    createdAt: new Date(now - DAY_MS).toISOString(),
    ...overrides,
  });
}

function couponRow(code: string): HTMLElement {
  const row = screen
    .getAllByRole('row')
    .find((element) => element.getAttribute('data-coupon-code') === code);
  if (!row) throw new Error(`No row for coupon ${code}`);
  return row;
}

describe('Pricing tab', () => {
  it('sets a tier, shows the share estimate and the history', async () => {
    catalogApi();
    const store = installCommerce();
    const user = userEvent.setup();
    renderBuilder('pricing');

    const select = await screen.findByRole('combobox', { name: 'Price tier' });
    expect(screen.getByText('Current price:').textContent).toContain('$19.99');
    expect((select as HTMLSelectElement).value).toBe('19.99');
    expect(screen.getByRole('button', { name: 'Save price' })).toHaveProperty('disabled', true);

    await user.selectOptions(select, '24.99');
    // round_half_up(24.99 × 70 %) = 17.49
    expect(screen.getByText(/You earn about/).textContent).toContain('$17.49');
    await user.click(screen.getByRole('button', { name: 'Save price' }));

    expect(await screen.findByText(/Price saved: \$24\.99/)).toBeTruthy();
    expect(store.courses.get(IDS.course)?.price).toBe('24.99');
    const historyTable = screen.getByRole('table', { name: 'Price changes, newest first' });
    const [, first] = within(historyTable).getAllByRole('row');
    expect(
      within(first!)
        .getAllByRole('cell')
        .slice(1)
        .map((cell) => cell.textContent),
    ).toEqual(['$19.99', '$24.99']);
  });

  it('explains that a free course earns nothing', async () => {
    catalogApi();
    installCommerce();
    const user = userEvent.setup();
    renderBuilder('pricing');

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Price tier' }), '0.00');
    expect(screen.getByText(/earns no revenue/)).toBeTruthy();
  });

  it('shows the daily limit with the Retry-After wait on 429', async () => {
    catalogApi();
    installCommerce();
    server.use(
      http.put(proxy(`/courses/${IDS.course}/pricing`), () => {
        const response = problemResponse(429, 'rate_limited');
        response.headers.set('retry-after', '7200');
        return response;
      }),
    );
    const user = userEvent.setup();
    renderBuilder('pricing');

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Price tier' }), '29.99');
    await user.click(screen.getByRole('button', { name: 'Save price' }));

    expect(
      await screen.findByText(
        'You can change the price at most 10 times a day. Try again in about 2 hours.',
      ),
    ).toBeTruthy();
  });

  it('puts price_not_allowed under the select', async () => {
    catalogApi();
    installCommerce();
    server.use(
      http.put(proxy(`/courses/${IDS.course}/pricing`), () =>
        problemResponse(422, 'price_not_allowed'),
      ),
    );
    const user = userEvent.setup();
    renderBuilder('pricing');

    const select = await screen.findByRole('combobox', { name: 'Price tier' });
    await user.selectOptions(select, '29.99');
    await user.click(screen.getByRole('button', { name: 'Save price' }));

    expect(await screen.findByText(/not one of the allowed price tiers/)).toBeTruthy();
    expect(select.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('"Set a price" warning', () => {
  it('shows on the builder header while the course has no price, until one is set', async () => {
    catalogApi();
    installCommerce({ course: { price: null } });
    const user = userEvent.setup();
    renderBuilder('details');

    const title = await screen.findByText('Set a price');
    expect(title.closest('[role="status"]')?.textContent).toContain(
      'students cannot buy or enroll',
    );

    await user.click(screen.getByRole('button', { name: 'Choose a price' }));
    expect(screen.getByRole('tab', { name: 'Pricing' }).getAttribute('aria-selected')).toBe('true');
    const select = await screen.findByRole('combobox', { name: 'Price tier' });
    expect((select as HTMLSelectElement).value).toBe('');
    await user.selectOptions(select, '49.99');
    await user.click(screen.getByRole('button', { name: 'Save price' }));

    await waitFor(() => expect(screen.queryByText('Set a price')).toBeNull());
    const historyTable = screen.getByRole('table', { name: 'Price changes, newest first' });
    expect(within(historyTable).getByText('No price')).toBeTruthy();
  });

  it('is not shown for a priced course', async () => {
    catalogApi();
    installCommerce();
    renderBuilder('pricing');

    await screen.findByRole('combobox', { name: 'Price tier' });
    expect(screen.queryByText('Set a price')).toBeNull();
  });
});

describe('Promotions tab', () => {
  it('lists active and inactive coupons with their redemption counts', async () => {
    catalogApi();
    installCommerce({
      coupons: [
        courseCoupon({
          id: '0b1f6d1e-0000-4000-8000-00000000c001',
          code: 'OLD10',
          percentOff: 10,
          deactivatedAt: new Date(Date.now() - DAY_MS / 2).toISOString(),
        }),
        courseCoupon({
          id: '0b1f6d1e-0000-4000-8000-00000000c002',
          code: 'LAUNCH50',
          maxRedemptions: 100,
          redemptions: { reserved: 2, consumed: 7 },
        }),
        courseCoupon({
          id: '0b1f6d1e-0000-4000-8000-00000000c003',
          code: 'FIVEOFF',
          discountType: 'AMOUNT',
          percentOff: null,
          amountOff: '5.00',
          currency: 'USD',
          maxRedemptions: null,
        }),
      ],
    });
    renderBuilder('promotions');

    await screen.findByRole('table', { name: 'Coupons, newest first' });
    const launch = within(couponRow('LAUNCH50'));
    expect(launch.getByText('50% off')).toBeTruthy();
    expect(launch.getByText('7 / 100 (2 in checkout)')).toBeTruthy();
    expect(launch.getByText('Active')).toBeTruthy();
    expect(launch.getByRole('button', { name: 'Deactivate LAUNCH50' })).toBeTruthy();

    const five = within(couponRow('FIVEOFF'));
    expect(five.getByText('$5.00 off')).toBeTruthy();
    expect(five.getByText('0 / unlimited')).toBeTruthy();

    const old = within(couponRow('OLD10'));
    expect(old.getByText('Deactivated')).toBeTruthy();
    expect(old.queryByRole('button', { name: /Deactivate/ })).toBeNull();
  });

  it('validates the create form with the contract rules before sending', async () => {
    catalogApi();
    installCommerce();
    let posted = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/coupons')) posted += 1;
    });
    const user = userEvent.setup();
    renderBuilder('promotions');

    await user.click(await screen.findByRole('button', { name: 'Create coupon' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create coupon' });
    const form = within(dialog);
    await user.click(form.getByRole('button', { name: 'Create coupon' }));
    expect(await form.findByText('Enter a code.')).toBeTruthy();
    expect(form.getByText('Enter a whole number from 1 to 100.')).toBeTruthy();

    const code = form.getByRole('textbox', { name: 'Code' });
    await user.type(code, 'ab!');
    expect((code as HTMLInputElement).value).toBe('AB!');
    await user.click(form.getByRole('radio', { name: 'Amount off (USD)' }));
    await user.type(form.getByRole('textbox', { name: 'Amount off' }), '25');
    await user.type(form.getByRole('textbox', { name: 'Maximum redemptions' }), '0');
    await user.click(form.getByRole('button', { name: 'Create coupon' }));

    expect(await form.findByText('Use 4–20 letters, digits, "_" or "-".')).toBeTruthy();
    expect(form.getByText('Must be at most $19.99, the list price.')).toBeTruthy();
    expect(form.getByText(/Enter a whole number from 1 to 100,000/)).toBeTruthy();
    expect(posted).toBe(0);
    server.events.removeAllListeners();
  });

  it('creates a coupon with a live price preview', async () => {
    catalogApi();
    const store = installCommerce();
    const user = userEvent.setup();
    renderBuilder('promotions');

    expect(await screen.findByText('No coupons yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create coupon' }));
    const form = within(await screen.findByRole('dialog', { name: 'Create coupon' }));
    await user.type(form.getByRole('textbox', { name: 'Code' }), 'launch-10');
    await user.type(form.getByRole('textbox', { name: 'Percent off' }), '10');
    // 19.99 − round_half_up(1.999) = 17.99
    expect(form.getByText(/Students pay/).textContent).toContain('$17.99');
    await user.type(form.getByRole('textbox', { name: 'Maximum redemptions' }), '50');
    await user.click(form.getByRole('button', { name: 'Create coupon' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = within(await waitFor(() => couponRow('LAUNCH-10')));
    expect(row.getByText('10% off')).toBeTruthy();
    expect(row.getByText('0 / 50')).toBeTruthy();
    const [created] = store.coupons;
    expect(created).toMatchObject({
      code: 'LAUNCH-10',
      discountType: 'PERCENT',
      percentOff: 10,
      maxRedemptions: 50,
    });
  });

  it('shows coupon_code_taken under the code field', async () => {
    catalogApi();
    installCommerce({ coupons: [courseCoupon({ code: 'LAUNCH50' })] });
    const user = userEvent.setup();
    renderBuilder('promotions');

    await user.click(await screen.findByRole('button', { name: 'Create coupon' }));
    const form = within(await screen.findByRole('dialog', { name: 'Create coupon' }));
    const code = form.getByRole('textbox', { name: 'Code' });
    await user.type(code, 'launch50');
    await user.type(form.getByRole('textbox', { name: 'Percent off' }), '20');
    await user.click(form.getByRole('button', { name: 'Create coupon' }));

    expect(await form.findByText('This course already has a coupon with this code.')).toBeTruthy();
    expect(code.getAttribute('aria-invalid')).toBe('true');
  });

  it('shows coupon_limit_exceeded as a form message', async () => {
    catalogApi();
    installCommerce();
    server.use(
      http.post(proxy(`/courses/${IDS.course}/coupons`), () =>
        problemResponse(422, 'coupon_limit_exceeded'),
      ),
    );
    const user = userEvent.setup();
    renderBuilder('promotions');

    await user.click(await screen.findByRole('button', { name: 'Create coupon' }));
    const form = within(await screen.findByRole('dialog', { name: 'Create coupon' }));
    await user.type(form.getByRole('textbox', { name: 'Code' }), 'SPRING');
    await user.type(form.getByRole('textbox', { name: 'Percent off' }), '20');
    await user.click(form.getByRole('button', { name: 'Create coupon' }));

    expect(await form.findByText(/at most 10 active coupons/)).toBeTruthy();
  });

  it('deactivates a coupon after confirmation', async () => {
    catalogApi();
    const store = installCommerce({ coupons: [courseCoupon({ code: 'LAUNCH50' })] });
    const user = userEvent.setup();
    renderBuilder('promotions');

    await user.click(await screen.findByRole('button', { name: 'Deactivate LAUNCH50' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Deactivate coupon LAUNCH50?' }),
    );
    await user.click(dialog.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() =>
      expect(within(couponRow('LAUNCH50')).getByText('Deactivated')).toBeTruthy(),
    );
    expect(store.coupons[0]?.deactivatedAt).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Deactivate LAUNCH50' })).toBeNull();
  });

  it('asks for a price first when the course has none', async () => {
    catalogApi();
    installCommerce({ course: { price: null } });
    renderBuilder('promotions');

    expect(await screen.findByText('Set a price first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create coupon' })).toBeNull();
  });
});
