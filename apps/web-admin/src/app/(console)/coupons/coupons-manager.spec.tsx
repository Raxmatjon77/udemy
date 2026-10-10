// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeCoupon } from '@udemy/contracts/testing';

import { ADMIN } from '@/test/commerce';
import { installCommerceStore, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { CouponsManager } from './coupons-manager';

setupMockApi();

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `datetime-local` value `days` from now (the form reads it as local time). */
function localIn(days: number): string {
  const date = new Date(Date.now() + days * DAY_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function openCreate(user: ReturnType<typeof renderWithClient>['user']) {
  await user.click(await screen.findByRole('button', { name: 'New coupon' }));
  return within(await screen.findByRole('dialog'));
}

describe('<CouponsManager>', () => {
  it('lists platform coupons with their terms, usage and state', async () => {
    installCommerceStore({
      viewerId: ADMIN,
      coupons: [
        makeCoupon({
          scope: 'PLATFORM',
          courseId: null,
          code: 'WELCOME10',
          discountType: 'PERCENT',
          percentOff: 10,
          amountOff: null,
          currency: null,
          maxRedemptions: 100,
          redemptions: { reserved: 2, consumed: 5 },
          startsAt: new Date(Date.now() - DAY_MS).toISOString(),
          endsAt: new Date(Date.now() + 10 * DAY_MS).toISOString(),
        }),
      ],
    });
    renderWithClient(<CouponsManager />);
    const row = await screen.findByText('WELCOME10').then((el) => el.closest('tr')!);
    expect(within(row).getByText('10% off')).toBeTruthy();
    expect(within(row).getByText('7 / 100')).toBeTruthy();
    expect(within(row).getByText('2 reserved in open checkouts')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
  });

  it('creates a percent coupon, normalizing the code', async () => {
    const store = installCommerceStore({ viewerId: ADMIN });
    const { user } = renderWithClient(<CouponsManager />);
    expect(await screen.findByText('No platform coupons yet.')).toBeTruthy();

    const dialog = await openCreate(user);
    await user.click(dialog.getByRole('button', { name: 'Create coupon' }));
    expect(await dialog.findByText('4–20 letters, digits, "_" or "-".')).toBeTruthy();
    expect(dialog.getByText('The discount must be a whole number from 1 to 100.')).toBeTruthy();
    expect(dialog.getByText('Choose an end date.')).toBeTruthy();

    await user.type(dialog.getByLabelText('Code'), 'fall-20');
    await user.type(dialog.getByLabelText('Percent off'), '20');
    fireEvent.change(dialog.getByLabelText('Ends'), { target: { value: localIn(14) } });
    await user.type(dialog.getByLabelText(/Maximum redemptions/), '500');
    await user.click(dialog.getByRole('button', { name: 'Create coupon' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Created FALL-20.')).toBeTruthy();
    const row = (await screen.findByText('FALL-20')).closest('tr')!;
    expect(within(row).getByText('20% off')).toBeTruthy();
    expect(within(row).getByText('0 / 500')).toBeTruthy();
    const [created] = store.listCoupons(null);
    expect(created).toMatchObject({ code: 'FALL-20', percentOff: 20, maxRedemptions: 500 });
  });

  it('rejects a window longer than 90 days and shows a taken code under the field', async () => {
    installCommerceStore({ viewerId: ADMIN });
    const { user } = renderWithClient(<CouponsManager />);
    await screen.findByText('No platform coupons yet.');

    let dialog = await openCreate(user);
    await user.type(dialog.getByLabelText('Code'), 'LAUNCH');
    await user.type(dialog.getByLabelText('Percent off'), '15');
    fireEvent.change(dialog.getByLabelText('Ends'), { target: { value: localIn(120) } });
    await user.click(dialog.getByRole('button', { name: 'Create coupon' }));
    expect(await dialog.findByText('A platform coupon runs for at most 90 days.')).toBeTruthy();
    fireEvent.change(dialog.getByLabelText('Ends'), { target: { value: localIn(30) } });
    await user.click(dialog.getByRole('button', { name: 'Create coupon' }));
    await screen.findByText('Created LAUNCH.');

    dialog = await openCreate(user);
    await user.type(dialog.getByLabelText('Code'), 'launch');
    await user.type(dialog.getByLabelText('Percent off'), '30');
    fireEvent.change(dialog.getByLabelText('Ends'), { target: { value: localIn(5) } });
    await user.click(dialog.getByRole('button', { name: 'Create coupon' }));
    expect(await dialog.findByText('Another platform coupon already uses this code.')).toBeTruthy();
    expect(dialog.getByLabelText('Code').getAttribute('aria-invalid')).toBe('true');
  });

  it('deactivates a coupon after confirmation', async () => {
    const store = installCommerceStore({ viewerId: ADMIN });
    store.createCoupon(null, {
      code: 'SPRING',
      discountType: 'PERCENT',
      percentOff: 25,
      endsAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
    });
    const { user } = renderWithClient(<CouponsManager />);
    await user.click(await screen.findByRole('button', { name: 'Deactivate SPRING' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/This cannot be undone/)).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText('Deactivated SPRING.')).toBeTruthy();
    const row = screen.getByText('SPRING').closest('tr')!;
    await within(row).findByText('Deactivated');
    expect(within(row).queryByRole('button', { name: 'Deactivate SPRING' })).toBeNull();
    expect(store.listCoupons(null)[0]?.state).toBe('DEACTIVATED');
  });
});
