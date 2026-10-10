import type { BrowserContext, Page } from '@playwright/test';

import { expect, type TestUser } from './fixtures';
import { cookieName, urls, type AppName } from './env';
import { extractTokenLink, type Mailpit } from './mailpit';

/** UI steps shared by several journeys. Locators are user-facing (roles and labels). */

export const SUBJECTS = {
  welcome: 'Welcome to Udemy Clone: confirm your email',
  reset: 'Reset your password',
  passwordChanged: 'Your password was changed',
  compromise: 'Security alert: a session was signed out',
  banned: 'Your account has been suspended',
  unbanned: 'Your account access has been restored',
  approved: "You're now an instructor",
} as const;

export const MESSAGES = {
  invalidCredentials: 'The email or password is incorrect.',
  banned: 'This account has been suspended. Contact support if you think this is a mistake.',
} as const;

/** Signs up in web-student and lands on the verify-pending page. */
export async function signUp(page: Page, user: TestUser): Promise<void> {
  await page.goto(`${urls.student}/signup`);
  await page.getByLabel('Full name').fill(user.displayName);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(`${urls.student}/verify-email/pending?from=signup`);
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
}

/** Fills and submits the login form of `app` (from `path`, default `/login`). */
export async function submitLogin(
  page: Page,
  app: AppName,
  credentials: { email: string; password: string },
  path = '/login',
): Promise<void> {
  if (path) await page.goto(`${urls[app]}${path}`);
  await page.getByLabel('Email').fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** Logs in and waits until the app has navigated away from the login page. */
export async function logIn(
  page: Page,
  app: AppName,
  credentials: { email: string; password: string },
  expectedPath: string | RegExp = '/',
): Promise<void> {
  await submitLogin(page, app, credentials);
  await expect(page).toHaveURL(
    typeof expectedPath === 'string' ? `${urls[app]}${expectedPath}` : expectedPath,
  );
}

/** A student account that exists (signed up through the UI) but is not verified. */
export async function signUpInNewPage(newPage: () => Promise<Page>, user: TestUser): Promise<void> {
  const page = await newPage();
  await signUp(page, user);
  await page.context().close();
}

/** Reads the verification mail and opens its link in `page`; asserts the success state. */
export async function verifyEmailFromMail(
  page: Page,
  mailpit: Mailpit,
  user: TestUser,
): Promise<void> {
  const mail = await mailpit.waitForMail({ to: user.email, subject: SUBJECTS.welcome });
  const link = extractTokenLink(mail, '/verify-email');
  expect(link.origin).toBe(urls.student);
  await page.goto(link.href);
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
}

/**
 * Asserts a page is signed out: the next navigation to a protected page ends on the login page
 * (proxy.ts redirect, or the client's 401 handler once the API rejects the revoked session).
 */
export async function expectLoggedOutOnNextNavigation(
  page: Page,
  app: AppName,
  protectedPath: string,
): Promise<void> {
  await page.goto(`${urls[app]}${protectedPath}`);
  await expect(page).toHaveURL(`${urls[app]}/login?next=${encodeURIComponent(protectedPath)}`);
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
}

/**
 * BUG (packages/web-auth, see README "Known bugs" #1): a session revoked on the server
 * (logout-all elsewhere, password reset, ban, refresh-token reuse) is NOT logged out on the next
 * navigation. proxy.ts only verifies the access JWT locally, so the protected page renders; its
 * `/api/proxy/*` call gets 401 `unauthorized` from the API, which the BFF passes through WITHOUT
 * clearing the cookies; the client then goes to `/login?next=…`, and proxy.ts sends the
 * still-"valid" token on that guest-only page back to `/` (307). The user stays on `/` with dead
 * cookies until the access token expires (≤ 14.5 min).
 *
 * Until it is fixed, the journeys assert what does hold: the API rejects the session and the
 * protected page does not stay open. `expectLoggedOutOnNextNavigation` (the intended behaviour)
 * runs in the `test.fixme` variant of each affected journey.
 */
export async function expectSessionEndedOnNextNavigation(
  page: Page,
  app: AppName,
  protectedPath: string,
): Promise<void> {
  const response = await page.request.get(`${urls[app]}/api/proxy/me`);
  expect(response.status(), 'the API rejects the revoked session').toBe(401);
  expect(((await response.json()) as { code?: string }).code).toBe('unauthorized');
  await page.goto(`${urls[app]}${protectedPath}`);
  await expect(page).not.toHaveURL(`${urls[app]}${protectedPath}`);
}

/**
 * How a journey checks that a revoked session is logged out on its next navigation:
 * `strict` = the intended behaviour (lands on `/login?next=…`), only in the `test.fixme`
 * variants until BUG #1 is fixed; `current` = what holds today (see above).
 */
export type LogoutCheck = 'strict' | 'current';

export function expectRevokedSessionLoggedOut(
  page: Page,
  app: AppName,
  protectedPath: string,
  check: LogoutCheck,
): Promise<void> {
  return check === 'strict'
    ? expectLoggedOutOnNextNavigation(page, app, protectedPath)
    : expectSessionEndedOnNextNavigation(page, app, protectedPath);
}

/** Sets one of the BFF's auth cookies directly (host-only, Secure, HttpOnly, like the BFF). */
export async function setAuthCookie(
  context: BrowserContext,
  app: AppName,
  kind: 'rt' | 'at',
  value: string,
): Promise<void> {
  await context.addCookies([
    {
      name: cookieName(app, kind),
      value,
      // Chromium only accepts a Secure cookie through CDP for an https URL. Cookies are not
      // port- or scheme-scoped, so this is the same host-only `localhost` cookie the BFF sets.
      url: `https://localhost:${new URL(urls[app]).port}`,
      secure: true,
      httpOnly: true,
      sameSite: app === 'admin' ? 'Strict' : 'Lax',
    },
  ]);
}

export async function getCookie(
  context: BrowserContext,
  app: AppName,
  kind: 'rt' | 'at',
): Promise<string | undefined> {
  const cookies = await context.cookies(urls[app]);
  return cookies.find((c) => c.name === cookieName(app, kind))?.value;
}
