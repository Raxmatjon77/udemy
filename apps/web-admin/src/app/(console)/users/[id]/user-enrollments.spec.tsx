// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AdminCoursePageSchema, AdminUserDetailSchema } from '@udemy/contracts';
import { FIXTURE_IDS, type CommerceMockStore } from '@udemy/contracts/testing';

import { ADMIN, STUDENT } from '@/test/commerce';
import { courseRow } from '@/test/fixtures';
import { installCommerceStore, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { UserDetail } from './user-detail';
import { UserEnrollments } from './user-enrollments';

setupMockApi();

const REASON = 'Scholarship granted by the support team.';

/** `/admin/courses?q=` answering with the mock store's courses that match the term. */
function courseSearch(store: CommerceMockStore) {
  server.use(
    http.get(proxy('/admin/courses'), ({ request }) => {
      const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
      const items = [...store.courses.values()]
        .filter((c) => c.title.toLowerCase().includes(q))
        .map((c, n) => courseRow(n, { id: c.id, slug: c.slug, title: c.title }));
      return HttpResponse.json(AdminCoursePageSchema.parse({ items, nextCursor: null }));
    }),
  );
}

function setup() {
  const store = installCommerceStore({ viewerId: ADMIN });
  store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course]);
  courseSearch(store);
  return store;
}

async function rowOf(title: string) {
  return (await screen.findByText(title)).closest('tr')!;
}

describe('<UserEnrollments>', () => {
  it('lists enrollments with source, status and history', async () => {
    setup();
    const { user } = renderWithClient(<UserEnrollments userId={STUDENT} userName="Jane Student" />);
    const row = await rowOf('Complete TypeScript');
    expect(within(row).getByText('Purchase')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    await user.click(within(row).getByText('History (1)'));
    expect(within(row).getByText(/Granted \(purchase\)/)).toBeTruthy();
  });

  it('grants a course picked by search, with a reason', async () => {
    const store = setup();
    const { user } = renderWithClient(<UserEnrollments userId={STUDENT} userName="Jane Student" />);
    await rowOf('Complete TypeScript');

    await user.click(screen.getByRole('button', { name: 'Grant enrollment' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Grant enrollment' }));
    expect(await dialog.findByText('Choose a course.')).toBeTruthy();

    await user.type(dialog.getByLabelText('Course'), 'post');
    await user.click(dialog.getByRole('button', { name: 'Search Course' }));
    await user.click(await dialog.findByRole('button', { name: /PostgreSQL in Depth/ }));
    expect(dialog.queryByText('Choose a course.')).toBeNull();
    await user.type(dialog.getByLabelText('Reason'), REASON);
    await user.click(dialog.getByRole('button', { name: 'Grant enrollment' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = await rowOf('PostgreSQL in Depth');
    expect(within(row).getByText('Granted by an admin')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    const granted = store.userEnrollments(STUDENT).find((e) => e.courseId === FIXTURE_IDS.course2)!;
    expect(granted.source).toBe('ADMIN');
    expect(granted.transitions.at(-1)?.reason).toBe(REASON);
  });

  it('explains an existing enrollment under the course field', async () => {
    setup();
    const { user } = renderWithClient(<UserEnrollments userId={STUDENT} userName="Jane Student" />);
    await rowOf('Complete TypeScript');
    await user.click(screen.getByRole('button', { name: 'Grant enrollment' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Course'), 'typescript');
    await user.click(dialog.getByRole('button', { name: 'Search Course' }));
    await user.click(await dialog.findByRole('button', { name: /Complete TypeScript/ }));
    await user.type(dialog.getByLabelText('Reason'), REASON);
    await user.click(dialog.getByRole('button', { name: 'Grant enrollment' }));
    expect(await dialog.findByText('This user is already enrolled in that course.')).toBeTruthy();
  });

  it('revokes an active enrollment with a reason', async () => {
    const store = setup();
    const { user } = renderWithClient(<UserEnrollments userId={STUDENT} userName="Jane Student" />);
    const row = await rowOf('Complete TypeScript');
    await user.click(within(row).getByRole('button', { name: 'Revoke Complete TypeScript' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/This does not refund the purchase/)).toBeTruthy();
    await user.type(dialog.getByLabelText('Reason'), 'Account shared with others.');
    await user.click(dialog.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const updated = await rowOf('Complete TypeScript');
    await within(updated).findByText('Revoked');
    expect(within(updated).getByText('Admin')).toBeTruthy();
    expect(within(updated).queryByRole('button', { name: /Revoke/ })).toBeNull();
    expect(store.userEnrollments(STUDENT)[0]).toMatchObject({
      status: 'REVOKED',
      revokeReason: 'ADMIN',
    });
  });

  it('is a tab of the user detail page', async () => {
    setup();
    server.use(
      http.get(proxy(`/admin/users/${STUDENT}`), () =>
        HttpResponse.json(
          AdminUserDetailSchema.parse({
            user: {
              id: STUDENT,
              email: 'jane@example.com',
              displayName: 'Jane Student',
              emailVerified: true,
              status: 'ACTIVE',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
            roles: ['STUDENT'],
            bans: [],
            activeSessionCount: 1,
          }),
        ),
      ),
    );
    const { user } = renderWithClient(<UserDetail id={STUDENT} currentUserId={ADMIN} />);
    await screen.findByRole('heading', { level: 2, name: 'Account' });
    expect(screen.getByRole('link', { name: 'View orders' }).getAttribute('href')).toBe(
      `/orders?userId=${STUDENT}`,
    );
    expect(screen.queryByRole('heading', { name: 'Enrollments' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Enrollments' }));
    expect(screen.getByRole('tab', { name: 'Enrollments' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Enrollments' })).toBeTruthy();
    expect(await screen.findByText('Complete TypeScript')).toBeTruthy();
    // arrow keys move between tabs
    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByRole('heading', { level: 2, name: 'Account' })).toBeTruthy();
  });
});
