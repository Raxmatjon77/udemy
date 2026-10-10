import { expect, test } from '../src/fixtures';
import { urls } from '../src/env';
import { getCookie, logIn, setAuthCookie, signUpInNewPage, submitLogin } from '../src/flows';

/** Admin pages and where a signed-out visit lands (`next` is omitted for the
 * admin home, /instructor-applications). */
const ADMIN_PAGES = [
  { path: '/', login: `/login?next=${encodeURIComponent('/')}` },
  { path: '/instructor-applications', login: '/login' },
  { path: '/users', login: `/login?next=${encodeURIComponent('/users')}` },
] as const;

test('access control: a student cannot reach any web-admin page', async ({
  newPage,
  newContext,
  users,
}) => {
  const student = users.next('NoAdmin');
  await signUpInNewPage(newPage, student);

  await test.step('signed out, every admin page redirects to /login?next=', async () => {
    const page = await newPage();
    for (const { path, login } of ADMIN_PAGES) {
      await page.goto(`${urls.admin}${path}`);
      await expect(page).toHaveURL(`${urls.admin}${login}`);
    }
  });

  await test.step('the student login on web-admin is refused (not an administrator)', async () => {
    const page = await newPage();
    await submitLogin(page, 'admin', student, `/login?next=${encodeURIComponent('/users')}`);
    await expect(
      page.getByRole('alert').filter({ hasText: 'This account is not an administrator.' }),
    ).toBeVisible();
    // No admin session was created, so the admin pages stay closed.
    expect(await getCookie(page.context(), 'admin', 'at')).toBeUndefined();
    expect(await getCookie(page.context(), 'admin', 'rt')).toBeUndefined();
    for (const { path, login } of ADMIN_PAGES) {
      await page.goto(`${urls.admin}${path}`);
      await expect(page).toHaveURL(`${urls.admin}${login}`);
    }
  });

  await test.step('a student-app token planted as the admin cookie is rejected (app confinement)', async () => {
    const context = await newContext();
    const studentPage = await context.newPage();
    await logIn(studentPage, 'student', student, '/');
    const studentAccessToken = await getCookie(context, 'student', 'at');
    expect(studentAccessToken).toBeTruthy();
    await setAuthCookie(context, 'admin', 'at', studentAccessToken ?? '');
    const adminPage = await context.newPage();
    await adminPage.goto(`${urls.admin}/users`);
    await expect(adminPage).toHaveURL(`${urls.admin}/login?next=${encodeURIComponent('/users')}`);
    expect(await getCookie(context, 'admin', 'at')).toBeUndefined();
  });
});

test('access control: a protected student page sends a signed-out user to login and back', async ({
  page,
  newPage,
  users,
}) => {
  const student = users.next('Next');
  await signUpInNewPage(newPage, student);

  await page.goto(`${urls.student}/account/profile`);
  await expect(page).toHaveURL(
    `${urls.student}/login?next=${encodeURIComponent('/account/profile')}`,
  );
  await submitLogin(page, 'student', student, '');
  await expect(page).toHaveURL(`${urls.student}/account/profile`);
  // The profile form loads through the BFF with the new session.
  await expect(page.getByLabel('Display name')).toHaveValue(student.displayName);
});
