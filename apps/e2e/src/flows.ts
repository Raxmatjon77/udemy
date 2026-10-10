import type { BrowserContext, Locator, Page } from '@playwright/test';

import { expect, type AdminCredentials, type TestUser } from './fixtures';
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
  // Phase 2 moderation (apps/worker/src/catalog/mail/catalog-mail.templates.ts).
  reviewRequested: (courseTitle: string) => `Review requested: "${courseTitle}"`,
  courseRejected: 'Your course was not approved',
  coursePublished: 'Your course is live',
  courseUpdatePublished: 'Your course update is live',
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

const APPLICATION_MOTIVATION =
  'I have taught TypeScript to junior developers for five years. My learners will be able to ' +
  'build and test a production web API on their own after finishing the course.';

/**
 * A verified student who applied and was approved by the e2e admin, all through the UI (the
 * onboarding journey's steps). Afterwards `user` can log in to web-instructor.
 */
export async function becomeInstructor(
  newPage: () => Promise<Page>,
  mailpit: Mailpit,
  admin: AdminCredentials,
  user: TestUser,
): Promise<void> {
  const page = await newPage();
  await signUp(page, user);
  await verifyEmailFromMail(page, mailpit, user);
  await logIn(page, 'student', user, '/');
  await page.goto(`${urls.student}/become-instructor`);
  await page.getByLabel('What will you teach?').fill('Web development with TypeScript');
  await page
    .getByLabel('Teaching experience')
    .selectOption({ label: 'Professionally (classes, workshops)' });
  await page.getByLabel('Why do you want to teach?').fill(APPLICATION_MOTIVATION);
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(
    page.getByRole('heading', { name: /Your application is under review/ }),
  ).toBeVisible();

  const adminPage = await newPage();
  await logIn(adminPage, 'admin', admin, '/instructor-applications');
  const applicant = adminPage.getByRole('link', { name: user.displayName });
  await loadMoreUntilVisible(adminPage, applicant);
  await applicant.click();
  await adminPage.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = adminPage.getByRole('dialog', { name: 'Approve this application?' });
  await dialog.getByRole('button', { name: 'Approve application' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    adminPage.getByRole('heading', { level: 1, name: new RegExp(user.displayName) }),
  ).toContainText('Approved');
  await page.context().close();
  await adminPage.context().close();
}

/** Keyset-paginated admin queues: clicks "Load more" until `target` is visible. */
export async function loadMoreUntilVisible(
  page: Page,
  target: Locator,
  timeout = 20_000,
): Promise<void> {
  await expect(async () => {
    if (await target.isVisible()) return;
    const more = page.getByRole('button', { name: 'Load more' });
    if (await more.isVisible()) await more.click();
    await expect(target).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout });
}
