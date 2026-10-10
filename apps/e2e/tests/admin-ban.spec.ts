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

const BAN_REASON = 'E2E: repeated spam in course discussions.';

test('admin ban: session ends, login refused, mail sent; unban restores access', async ({
  newPage,
  users,
  admin,
  mailpit,
}) => {
  const user = users.next('Banned');
  await signUpInNewPage(newPage, user);

  const userPage = await newPage();
  await logIn(userPage, 'student', user, '/');
  await userPage.goto(`${urls.student}/account/sessions`);
  await expect(userPage.getByRole('heading', { name: 'Sessions & security' })).toBeVisible();

  const adminPage = await newPage();
  const heading = adminPage.getByRole('heading', { level: 1, name: new RegExp(user.displayName) });

  await test.step('the admin finds the user and bans them from /users/[id]', async () => {
    await logIn(adminPage, 'admin', admin, '/instructor-applications');
    await adminPage.getByRole('link', { name: 'Users' }).first().click();
    await expect(adminPage).toHaveURL(new RegExp(`^${urls.admin}/users`));
    await adminPage.getByLabel('Name or email').fill(user.email);
    await adminPage.getByRole('button', { name: 'Search' }).click();
    await adminPage.getByRole('link', { name: user.displayName }).click();
    await expect(adminPage).toHaveURL(new RegExp(`^${urls.admin}/users/[0-9a-f-]{36}$`));
    await expect(heading).toContainText('Active');

    await adminPage.getByRole('button', { name: 'Ban user' }).click();
    const dialog = adminPage.getByRole('dialog', { name: `Ban ${user.displayName}?` });
    await dialog.getByLabel('Reason').fill(BAN_REASON);
    await dialog.getByRole('button', { name: 'Ban user' }).click();
    await expect(dialog).toBeHidden();
    await expect(heading).toContainText('Banned');
    await expect(adminPage.getByRole('cell', { name: BAN_REASON })).toBeVisible();
  });

  await test.step("the user's open session is logged out on its next navigation", async () => {
    // The ban revoked the session (API: 401 `unauthorized`); the BFF clears the cookies and the
    // client lands on /login?next=….
    await expectLoggedOutOnNextNavigation(userPage, 'student', '/account/sessions');
  });

  await test.step('the login (in the same browser) shows the banned message', async () => {
    await submitLogin(userPage, 'student', user);
    await expect(userPage.getByRole('alert').filter({ hasText: MESSAGES.banned })).toBeVisible();
    await expect(userPage).toHaveURL(`${urls.student}/login`);
  });

  await test.step('the ban mail arrives', async () => {
    const mail = await mailpit.waitForMail({ to: user.email, subject: SUBJECTS.banned });
    expect(mail.Text).toContain(BAN_REASON);
  });

  await test.step('the admin lifts the ban', async () => {
    await adminPage.getByRole('button', { name: 'Lift ban' }).click();
    const dialog = adminPage.getByRole('dialog', { name: `Lift the ban on ${user.displayName}?` });
    await dialog.getByRole('button', { name: 'Lift ban' }).click();
    await expect(dialog).toBeHidden();
    await expect(heading).toContainText('Active');
  });

  await test.step('the unban mail arrives and the login works again', async () => {
    await mailpit.waitForMail({ to: user.email, subject: SUBJECTS.unbanned });
    const page = await newPage();
    await logIn(page, 'student', user, '/');
  });
});
