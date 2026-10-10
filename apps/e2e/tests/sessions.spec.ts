import { expect, test } from '../src/fixtures';
import { urls } from '../src/env';
import { expectLoggedOutOnNextNavigation, logIn, signUpInNewPage } from '../src/flows';

test('sessions: two devices listed, "sign out everywhere" ends the other one', async ({
  newPage,
  users,
}) => {
  const user = users.next('Sessions');
  await signUpInNewPage(newPage, user);

  const a = await newPage();
  const b = await newPage();
  await logIn(a, 'student', user, '/');
  await logIn(b, 'student', user, '/');

  await test.step('context A lists both sessions', async () => {
    await a.goto(`${urls.student}/account/sessions`);
    await expect(a.getByRole('heading', { name: 'Sessions & security' })).toBeVisible();
    const list = a.getByRole('list').filter({ hasText: 'This device' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByText('This device')).toHaveCount(1);
    // The other session (B) can be signed out individually.
    await expect(list.getByRole('button', { name: /^Sign out / })).toHaveCount(1);
  });

  await test.step('context A signs out of all devices and lands on the login page', async () => {
    await a.getByRole('button', { name: 'Sign out of all devices' }).click();
    const dialog = a.getByRole('dialog', { name: 'Sign out of all devices?' });
    await dialog.getByRole('button', { name: 'Sign out everywhere' }).click();
    // Exactly /login: the tab ignores its own BroadcastChannel('auth') logout message, so it
    // does not reload into /login?next=/account/sessions.
    await expect(a).toHaveURL(`${urls.student}/login`);
    await expect(a.getByRole('button', { name: 'Log in' })).toBeVisible();
    // ... and stays there (no late reload from its own broadcast).
    expect(a.url()).toBe(`${urls.student}/login`);
  });

  await test.step('context B is logged out on its next navigation', async () => {
    // B's access JWT is still valid locally; the API rejects the revoked session (401
    // `unauthorized`), the BFF clears B's cookies and the client lands on /login?next=….
    await expectLoggedOutOnNextNavigation(b, 'student', '/account/sessions');
  });
});
