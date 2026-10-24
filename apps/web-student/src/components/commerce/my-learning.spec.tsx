/** @vitest-environment jsdom */
import { screen, within } from '@testing-library/react';
import { FIXTURE_IDS } from '@udemy/contracts/testing';
import { describe, expect, it } from 'vitest';

import { mockCommerce } from '@/test/commerce';
import { setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { MyLearning } from './my-learning';

const server = setupMswServer();

describe('<MyLearning>', () => {
  it('lists the enrolled courses with their badges and links', async () => {
    const store = mockCommerce(server);
    store.seedPaidOrder(FIXTURE_IDS.student, [FIXTURE_IDS.course]);
    store.enrollFree(FIXTURE_IDS.freeCourse);
    store.courses.get(FIXTURE_IDS.course)!.status = 'ARCHIVED';
    renderWithQuery(<MyLearning />);

    const cards = await screen.findAllByTestId('learning-card');
    expect(cards).toHaveLength(2);
    const byTitle = (title: string) =>
      cards.find((card) => within(card).queryByRole('link', { name: title }))!;

    const archived = byTitle('Complete TypeScript');
    expect(within(archived).getByText('Archived')).toBeTruthy();
    expect(within(archived).getByText('Start learning')).toBeTruthy();
    expect(
      within(archived).getByRole('link', { name: 'Complete TypeScript' }).getAttribute('href'),
    ).toBe(`/learn/${FIXTURE_IDS.course}`);

    const free = byTitle('Git Basics');
    expect(within(free).getByText('Free')).toBeTruthy();
    expect(within(free).queryByText('Archived')).toBeNull();
  });

  it('shows an empty state', async () => {
    mockCommerce(server);
    renderWithQuery(<MyLearning />);
    expect(await screen.findByText('You are not enrolled in any course yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse courses' }).getAttribute('href')).toBe(
      '/courses',
    );
  });

  it('leaves out revoked (refunded) enrollments', async () => {
    const store = mockCommerce(server);
    const order = store.seedPaidOrder(FIXTURE_IDS.student, [FIXTURE_IDS.course]);
    store.requestRefund(order.id, { orderLineId: order.lines[0]!.id, reasonCode: 'QUALITY' });
    renderWithQuery(<MyLearning />);
    expect(await screen.findByText('You are not enrolled in any course yet')).toBeTruthy();
  });
});
