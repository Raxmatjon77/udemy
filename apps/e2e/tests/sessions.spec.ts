import { expect, test, type JourneyFixtures } from '../src/fixtures';
import { urls } from '../src/env';
import {
  expectRevokedSessionLoggedOut,
  logIn,
  signUpInNewPage,
  type LogoutCheck,
} from '../src/flows';

async function sessionsJourney(
  { newPage, users }: Pick<JourneyFixtures, 'newPage' | 'users'>,
  logoutCheck: LogoutCheck,
): Promise<void> {
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
    // Finding #2 (minor, packages/web-auth/client): logout() navigates to /login, but the same
    // tab also receives its own BroadcastChannel('auth') message and reloads, so it can land on
    // /login?next=/account/sessions instead. Both are a logged-out login page.
    await expect(a).toHaveURL(
      new RegExp(`^${urls.student}/login(\\?next=${encodeURIComponent('/account/sessions')})?$`),
    );
    await expect(a.getByRole('button', { name: 'Log in' })).toBeVisible();
  });

  await test.step('context B is logged out on its next navigation', async () => {
    await expectRevokedSessionLoggedOut(b, 'student', '/account/sessions', logoutCheck);
  });
}

test('sessions: two devices listed, "sign out everywhere" ends the other one', ({
  newPage,
  users,
}) => sessionsJourney({ newPage, users }, 'current'));

// BUG #1 (packages/web-auth, apps/e2e/README.md "Known bugs"): after "sign out everywhere" in A,
// B's calls get 401 `unauthorized` but the BFF keeps B's cookies, so B's next navigation ends on
// `/` (login → 307 → `/`) instead of `/login?next=/account/sessions`.
test.fixme('sessions: the other device lands on /login on its next navigation', ({
  newPage,
  users,
}) => sessionsJourney({ newPage, users }, 'strict'));
