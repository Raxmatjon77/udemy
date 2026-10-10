import { expect, test, type JourneyFixtures } from '../src/fixtures';
import { cookieName, urls } from '../src/env';
import {
  expectRevokedSessionLoggedOut,
  getCookie,
  logIn,
  SUBJECTS,
  setAuthCookie,
  signUpInNewPage,
  type LogoutCheck,
} from '../src/flows';

/** The API answers a replayed refresh token with the grace path for this long (design §9). */
const REUSE_GRACE_MS = 10_000;
const GRACE_MARGIN_MS = 1_500;

const SKIP_SLOW = process.env.E2E_SKIP_SLOW === '1';
const SKIP_REASON = 'E2E_SKIP_SLOW=1 skips the journey that waits out the 10 s reuse-grace window';

async function reuseJourney(
  {
    newContext,
    newPage,
    users,
    mailpit,
  }: Pick<JourneyFixtures, 'newContext' | 'newPage' | 'users' | 'mailpit'>,
  logoutCheck: LogoutCheck,
): Promise<void> {
  const user = users.next('Reuse');
  await signUpInNewPage(newPage, user);
  const contextA = await newContext();
  const a = await contextA.newPage();
  await logIn(a, 'student', user, '/');

  const oldRefreshToken = await getCookie(contextA, 'student', 'rt');
  expect(oldRefreshToken, 'refresh cookie after login').toBeTruthy();

  let rotatedAt = 0;
  await test.step('the app rotates the refresh token (access cookie expired)', async () => {
    // Dropping the access cookie is what its 870 s Max-Age does: proxy.ts then refreshes
    // inline on the next page navigation and stores the rotated refresh token.
    await contextA.clearCookies({ name: cookieName('student', 'at') });
    await a.goto(`${urls.student}/account/sessions`);
    await expect(a.getByRole('heading', { name: 'Sessions & security' })).toBeVisible();
    await expect
      .poll(() => getCookie(contextA, 'student', 'rt'), { message: 'rotated refresh cookie' })
      .not.toBe(oldRefreshToken);
    expect(await getCookie(contextA, 'student', 'at')).toBeTruthy();
    rotatedAt = Date.now();
  });

  await test.step('wait out the 10 s reuse-grace window', async () => {
    // Deliberately time-based: inside the window the API treats the old token as a benign
    // race (parallel tabs/pods) and answers with an access token only. Nothing in the UI or on
    // the network changes when the window closes, so there is no event to wait for.
    const remaining = rotatedAt + REUSE_GRACE_MS + GRACE_MARGIN_MS - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  });

  await test.step('replaying the OLD refresh token in a fresh browser fails', async () => {
    const attacker = await newContext();
    await setAuthCookie(attacker, 'student', 'rt', oldRefreshToken ?? '');
    const page = await attacker.newPage();
    await page.goto(`${urls.student}/account/sessions`);
    await expect(page).toHaveURL(
      `${urls.student}/login?next=${encodeURIComponent('/account/sessions')}`,
    );
    // The BFF cleared the rejected cookie.
    expect(await getCookie(attacker, 'student', 'rt')).toBeUndefined();
  });

  await test.step('the original session is logged out as well', async () => {
    await expectRevokedSessionLoggedOut(a, 'student', '/account/profile', logoutCheck);
  });

  await test.step('the "session compromise" mail arrives', async () => {
    const mail = await mailpit.waitForMail({ to: user.email, subject: SUBJECTS.compromise });
    expect(mail.Text).toContain('used twice');
  });
}

test('refresh-token reuse: replaying a rotated token ends the whole session', ({
  newContext,
  newPage,
  users,
  mailpit,
}) => {
  test.skip(SKIP_SLOW, SKIP_REASON);
  return reuseJourney({ newContext, newPage, users, mailpit }, 'current');
});

// BUG #1 (packages/web-auth, apps/e2e/README.md "Known bugs"): after the reuse is detected the
// API rejects A's session (401 `unauthorized`), but the BFF keeps A's cookies, so A's next
// navigation ends on `/` instead of `/login?next=/account/profile`.
test.fixme('refresh-token reuse: the original session lands on /login on its next navigation', ({
  newContext,
  newPage,
  users,
  mailpit,
}) => {
  test.skip(SKIP_SLOW, SKIP_REASON);
  return reuseJourney({ newContext, newPage, users, mailpit }, 'strict');
});
