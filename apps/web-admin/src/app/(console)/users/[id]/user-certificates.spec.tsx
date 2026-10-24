// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { COURSE, installLearning, seedCertificate, STUDENT } from '@/test/learning';
import { setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { UserCertificates } from './user-certificates';

setupMockApi();

const REASON = 'Plagiarised the final project, confirmed by support.';

async function rowOf(title: string) {
  return (await screen.findByText(title)).closest('tr')!;
}

describe('<UserCertificates>', () => {
  it('lists the certificates with code, status and history', async () => {
    const store = installLearning();
    seedCertificate(store);
    const { user } = renderWithClient(
      <UserCertificates userId={STUDENT} userName="Jane Student" />,
    );
    const row = within(await rowOf('Complete TypeScript'));
    const [cert] = store.adminUserCertificates(STUDENT);
    expect(row.getByText(cert!.certificate.code)).toBeTruthy();
    expect(row.getByText('Active')).toBeTruthy();
    await user.click(row.getByRole('button', { name: 'History (1)' }));
    expect(row.getByText(/course completed/)).toBeTruthy();
  });

  it('says so when the user has none', async () => {
    installLearning();
    renderWithClient(<UserCertificates userId={STUDENT} userName="Jane Student" />);
    expect(await screen.findByText('This user has no certificates.')).toBeTruthy();
  });

  it('revokes with a reason, and the admin revocation sticks across a re-grant', async () => {
    const store = installLearning();
    seedCertificate(store);
    const { user, queryClient } = renderWithClient(
      <UserCertificates userId={STUDENT} userName="Jane Student" />,
    );
    const row = within(await rowOf('Complete TypeScript'));
    await user.click(row.getByRole('button', { name: 'Revoke certificate: Complete TypeScript' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/re-enrolling the student does not reinstate it/)).toBeTruthy();
    await user.type(dialog.getByLabelText('Reason'), REASON);
    await user.click(dialog.getByRole('button', { name: 'Revoke certificate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await row.findByText('Revoked')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Revoked the certificate');

    // The enrollment is revoked (refund) and re-granted: the certificate stays revoked.
    store.commerce.revokeEnrollmentOf(STUDENT, COURSE, 'REFUND');
    store.commerce.seedEnrollment(STUDENT, COURSE);
    await queryClient.invalidateQueries();
    const [entry] = store.adminUserCertificates(STUDENT);
    expect(entry!.certificate.status).toBe('REVOKED');
    expect(entry!.transitions.at(-1)).toMatchObject({
      action: 'REVOKE',
      cause: 'ADMIN',
      reason: REASON,
    });
    expect(await row.findByRole('button', { name: /Reinstate certificate/ })).toBeTruthy();
  });

  it('reinstates a revoked certificate', async () => {
    const store = installLearning();
    seedCertificate(store);
    const [cert] = store.adminUserCertificates(STUDENT);
    store.adminTransitionCertificate(cert!.certificate.id, 'revoke', REASON);
    const { user } = renderWithClient(
      <UserCertificates userId={STUDENT} userName="Jane Student" />,
    );
    const row = within(await rowOf('Complete TypeScript'));
    await user.click(
      row.getByRole('button', { name: 'Reinstate certificate: Complete TypeScript' }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), 'Appeal accepted after review.');
    await user.click(dialog.getByRole('button', { name: 'Reinstate certificate' }));
    expect(await row.findByText('Active')).toBeTruthy();
    expect(store.adminUserCertificates(STUDENT)[0]!.certificate.status).toBe('ACTIVE');
  });

  it('explains a 409 when another admin changed it first', async () => {
    const store = installLearning();
    seedCertificate(store);
    const { user } = renderWithClient(
      <UserCertificates userId={STUDENT} userName="Jane Student" />,
    );
    const row = within(await rowOf('Complete TypeScript'));
    const [cert] = store.adminUserCertificates(STUDENT);
    store.adminTransitionCertificate(cert!.certificate.id, 'revoke', 'Revoked by another admin.');
    await user.click(row.getByRole('button', { name: 'Revoke certificate: Complete TypeScript' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), REASON);
    await user.click(dialog.getByRole('button', { name: 'Revoke certificate' }));
    expect(
      await dialog.findByText('This certificate was already changed. The list was refreshed.'),
    ).toBeTruthy();
  });
});
