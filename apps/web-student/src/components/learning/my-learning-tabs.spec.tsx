/** @vitest-environment jsdom */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_IDS, LEARNING_FIXTURE_IDS } from '@udemy/contracts/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockLearning } from '@/test/learning';
import { setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { MyLearningTabs } from './my-learning-tabs';

const assigned = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('@/lib/commerce/navigation', () => ({
  assignLocation: (url: string) => assigned.urls.push(url),
}));

const server = setupMswServer();
const { course, course2, freeCourse, student } = FIXTURE_IDS;

beforeEach(() => {
  assigned.urls = [];
});

describe('<MyLearningTabs> courses', () => {
  it('shows each course progress, a Completed badge at 100% and links to the player', async () => {
    const store = mockLearning(server);
    store.commerce.seedEnrollment(student, course);
    store.commerce.seedEnrollment(student, freeCourse);
    store.seedCompletion(student, course, [LEARNING_FIXTURE_IDS.lectureArticle]);
    store.seedCompletion(student, freeCourse);
    renderWithQuery(<MyLearningTabs />);

    const cards = await screen.findAllByTestId('learning-card');
    const byTitle = (title: string) =>
      cards.find((card) => within(card).queryByRole('link', { name: title }))!;

    const ts = byTitle('Complete TypeScript');
    expect(within(ts).getByRole('link', { name: 'Complete TypeScript' }).getAttribute('href')).toBe(
      `/learn/${course}`,
    );
    expect(within(ts).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(within(ts).getByTestId('learning-progress').textContent).toBe('25% complete · Continue');
    expect(within(ts).queryByText('Completed')).toBeNull();

    const git = byTitle('Git Basics');
    expect(within(git).getByText('Completed')).toBeTruthy();
    expect(within(git).getByTestId('learning-progress').textContent).toBe('100% complete');
  });

  it('says "Start learning" before any progress', async () => {
    const store = mockLearning(server);
    store.commerce.seedEnrollment(student, course);
    renderWithQuery(<MyLearningTabs />);
    const card = await screen.findByTestId('learning-card');
    expect(within(card).getByTestId('learning-progress').textContent).toBe('Start learning');
    expect(within(card).queryByRole('progressbar')).toBeNull();
  });
});

describe('<MyLearningTabs> wishlist', () => {
  it('lists the wishlist and removes a course', async () => {
    const user = userEvent.setup();
    const store = mockLearning(server);
    store.addToWishlist(course2);
    renderWithQuery(<MyLearningTabs />);
    await user.click(screen.getByRole('tab', { name: 'Wishlist' }));

    const item = await screen.findByTestId('wishlist-item');
    expect(
      within(item).getByRole('link', { name: 'PostgreSQL in Depth' }).getAttribute('href'),
    ).toBe('/course/postgres-in-depth');
    await user.click(
      within(item).getByRole('button', { name: 'Remove PostgreSQL in Depth from your wishlist' }),
    );
    expect(await screen.findByText('Your wishlist is empty')).toBeTruthy();
    expect(store.wishlist()).toEqual([]);
  });
});

describe('<MyLearningTabs> certificates', () => {
  it('lists my certificates with the share link and the PDF download; revoked ones say so', async () => {
    const user = userEvent.setup();
    const store = mockLearning(server);
    store.commerce.seedEnrollment(student, course);
    store.commerce.seedEnrollment(student, freeCourse);
    store.seedCompletion(student, course);
    store.seedCompletion(student, freeCourse);
    store.commerce.revokeEnrollmentOf(student, freeCourse);
    renderWithQuery(<MyLearningTabs />);
    await user.click(screen.getByRole('tab', { name: 'Certificates' }));

    const items = await screen.findAllByTestId('my-certificate');
    expect(items).toHaveLength(2);
    const active = items.find((i) => within(i).queryByText('Complete TypeScript'))!;
    const revoked = items.find((i) => within(i).queryByText('Git Basics'))!;
    const [cert] = store.myCertificates().filter((c) => c.courseId === course);
    expect(within(active).getByRole('link', { name: 'Share link' }).getAttribute('href')).toBe(
      `/certificates/${cert!.code}`,
    );
    expect(within(revoked).getByText('Revoked')).toBeTruthy();
    expect(within(revoked).queryByRole('button', { name: 'Download PDF' })).toBeNull();

    await user.click(within(active).getByRole('button', { name: 'Download PDF' }));
    await waitFor(() =>
      expect(assigned.urls).toEqual([expect.stringContaining('https://media.test/')]),
    );
  });

  it('explains a PDF that is still being rendered (409)', async () => {
    const store = mockLearning(server, { certificatePdfReady: false });
    store.commerce.seedEnrollment(student, course);
    store.seedCompletion(student, course);
    const user = userEvent.setup();
    renderWithQuery(<MyLearningTabs />);
    await user.click(screen.getByRole('tab', { name: 'Certificates' }));
    const item = await screen.findByTestId('my-certificate');
    expect(within(item).getByText('PDF in preparation')).toBeTruthy();
  });
});
