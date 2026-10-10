import { expect, test } from '../src/fixtures';
import { urls } from '../src/env';
import {
  expectLoggedOutOnNextNavigation,
  logIn,
  MESSAGES,
  SUBJECTS,
  signUpInNewPage,
  submitLogin,
} from '../src/flows';
import { extractTokenLink } from '../src/mailpit';

test('password reset: mail link → new password works, old fails, old session ends', async ({
  page,
  newPage,
  users,
  mailpit,
}) => {
  const user = users.next('Reset');
  const newPassword = `new-${user.password}`;
  await signUpInNewPage(newPage, user);

  // A session opened BEFORE the reset, in its own browser.
  const before = await newPage();
  await logIn(before, 'student', user, '/');
  await before.goto(`${urls.student}/account/sessions`);
  await expect(before.getByRole('heading', { name: 'Sessions & security' })).toBeVisible();

  await test.step('request a reset link on /forgot-password', async () => {
    await page.goto(`${urls.student}/login`);
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(`${urls.student}/forgot-password`);
    await page.getByLabel('Email').fill(user.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Check your inbox' })).toBeVisible();
  });

  await test.step('open the reset link from the mail and choose a new password', async () => {
    const mail = await mailpit.waitForMail({ to: user.email, subject: SUBJECTS.reset });
    const link = extractTokenLink(mail, '/reset-password');
    expect(link.origin).toBe(urls.student);
    await page.goto(link.href);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    // The token was taken from the fragment and the fragment removed from the address bar.
    await expect(page).toHaveURL(`${urls.student}/reset-password`);
    expect(await page.evaluate(() => window.location.hash)).toBe('');

    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  });

  await test.step('the "password changed" notice arrives', async () => {
    await mailpit.waitForMail({ to: user.email, subject: SUBJECTS.passwordChanged });
  });

  await test.step('the session opened before the reset is logged out on its next navigation', async () => {
    // The reset revoked every session (API: 401 `unauthorized`); the BFF clears the cookies
    // and the client lands on /login?next=….
    await expectLoggedOutOnNextNavigation(before, 'student', '/account/sessions');
  });

  await test.step('the old password fails', async () => {
    const page2 = await newPage();
    await submitLogin(page2, 'student', user);
    await expect(
      page2.getByRole('alert').filter({ hasText: MESSAGES.invalidCredentials }),
    ).toBeVisible();
    await expect(page2).toHaveURL(`${urls.student}/login`);
  });

  await test.step('the new password works', async () => {
    const page3 = await newPage();
    await logIn(page3, 'student', { email: user.email, password: newPassword }, '/');
  });
});
