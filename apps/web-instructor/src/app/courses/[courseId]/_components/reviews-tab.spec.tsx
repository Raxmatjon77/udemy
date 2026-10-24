// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { LearningMockStore } from '@udemy/contracts/testing';

import { COURSE, enrollStudent, installLearning, STUDENT } from '@/test/learning';
import { setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { ReviewsTab } from './reviews-tab';

setupMockApi();

function setup(seed: (store: LearningMockStore) => void = () => {}) {
  const store = installLearning();
  enrollStudent(store);
  const reviewId = store.seedReview(
    STUDENT,
    COURSE,
    4,
    'Great course,\nbut the last section is rushed.',
  );
  seed(store);
  const user = userEvent.setup();
  renderWithClient(<ReviewsTab courseId={COURSE} />);
  const review = () => store.instructorReviews(COURSE).find((r) => r.id === reviewId)!;
  return { store, user, review };
}

const reviewItem = () => screen.findByRole('listitem', { name: 'Jane Student' });

describe('<ReviewsTab>', () => {
  it('lists reviews with the rating and the plain-text body', async () => {
    setup();
    const item = await reviewItem();
    expect(within(item).getByText('Rated 4 out of 5')).toBeTruthy();
    expect(within(item).getByText(/the last section is rushed/)).toBeTruthy();
  });

  it('replies, edits the reply and deletes it', async () => {
    const { user, review } = setup();
    const item = await reviewItem();
    await user.click(within(item).getByRole('button', { name: 'Reply to Jane Student' }));
    await user.click(within(item).getByRole('button', { name: 'Save reply' }));
    expect(await within(item).findByRole('alert')).toBeTruthy();

    await user.type(
      within(item).getByLabelText('Your public reply'),
      'Thanks! We are reworking it.',
    );
    await user.click(within(item).getByRole('button', { name: 'Save reply' }));
    expect(await within(item).findByText('Thanks! We are reworking it.')).toBeTruthy();
    expect(review().reply?.body).toBe('Thanks! We are reworking it.');

    await user.click(within(item).getByRole('button', { name: 'Edit your reply to Jane Student' }));
    const field = within(item).getByLabelText('Your public reply');
    await user.clear(field);
    await user.type(field, 'Section 5 is updated now.');
    await user.click(within(item).getByRole('button', { name: 'Save reply' }));
    expect(await within(item).findByText('Section 5 is updated now.')).toBeTruthy();
    expect(within(item).getByText('· edited')).toBeTruthy();

    await user.click(
      within(item).getByRole('button', { name: 'Delete your reply to Jane Student' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete reply' }));
    await waitFor(() => expect(review().reply).toBeNull());
    expect(await within(item).findByRole('button', { name: 'Reply to Jane Student' })).toBeTruthy();
  });

  it('filters by rating', async () => {
    const { user } = setup((store) =>
      store.seedReview(store.adminIds[0]!, COURSE, 2, 'Too fast for me.'),
    );
    const list = await screen.findByRole('list', { name: 'Reviews' });
    await within(list).findByText('Too fast for me.');
    expect(within(list).getByText(/rushed/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Rating'), '2');
    // A new rating is a new query: the list is re-rendered from its first page.
    await waitFor(() => expect(screen.queryByText(/rushed/)).toBeNull());
    expect(await screen.findByText('Too fast for me.')).toBeTruthy();
  });

  it('shows a suspended review (enrollment revoked) without a reply button', async () => {
    setup((store) => store.commerce.revokeEnrollmentOf(STUDENT, COURSE));
    const item = await reviewItem();
    expect(within(item).getByText('Suspended: enrollment revoked')).toBeTruthy();
    expect(within(item).queryByRole('button', { name: /Reply/ })).toBeNull();
  });
});
