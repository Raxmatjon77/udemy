import { expect, test } from '../src/fixtures';
import { urls } from '../src/env';
import { logIn, SUBJECTS, signUp, submitLogin, verifyEmailFromMail } from '../src/flows';

const MOTIVATION =
  'I have taught TypeScript to junior developers for five years. My learners will be able to ' +
  'build and test a production web API on their own after finishing the course.';

test('student onboarding: signup → verify → apply → admin approves → instructor app', async ({
  page,
  newPage,
  users,
  mailpit,
  admin,
}) => {
  const student = users.next('Applicant');

  await test.step('sign up in web-student and land on the verify-pending page', async () => {
    await signUp(page, student);
  });

  await test.step('open the verification link: token consumed, fragment removed', async () => {
    await verifyEmailFromMail(page, mailpit, student);
    await expect(page).toHaveURL(`${urls.student}/verify-email`);
    expect(await page.evaluate(() => window.location.hash)).toBe('');
  });

  await test.step('log in to web-student', async () => {
    await logIn(page, 'student', student, '/');
  });

  await test.step('submit the instructor application', async () => {
    await page.goto(`${urls.student}/become-instructor`);
    await expect(page.getByRole('heading', { name: 'Your application' })).toBeVisible();
    await page.getByLabel('What will you teach?').fill('Web development with TypeScript');
    await page
      .getByLabel('Teaching experience')
      .selectOption({ label: 'Professionally (classes, workshops)' });
    await page.getByLabel('Why do you want to teach?').fill(MOTIVATION);
    await page.getByRole('button', { name: 'Submit application' }).click();
    await expect(
      page.getByRole('heading', { name: /Your application is under review/ }),
    ).toBeVisible();
  });

  await test.step('before approval, web-instructor refuses the login (app access denied)', async () => {
    const instructorPage = await newPage();
    await submitLogin(instructorPage, 'instructor', student);
    const alert = instructorPage.getByRole('alert').filter({
      hasText: 'This account is not an instructor yet',
    });
    await expect(alert).toBeVisible();
    await expect(
      alert.getByRole('link', { name: 'Apply to become an instructor' }),
    ).toHaveAttribute('href', `${urls.student}/become-instructor`);
    await expect(instructorPage).toHaveURL(`${urls.instructor}/login`);
    // No session was created: the dashboard still sends the user to the login page.
    await instructorPage.goto(`${urls.instructor}/`);
    await expect(instructorPage).toHaveURL(`${urls.instructor}/login`);
  });

  await test.step('the e2e admin approves the application in web-admin', async () => {
    const adminPage = await newPage();
    await logIn(adminPage, 'admin', admin, '/instructor-applications');
    await expect(adminPage.getByRole('heading', { level: 1 })).toBeVisible();

    const applicant = adminPage.getByRole('link', { name: student.displayName });
    // The queue is keyset-paginated: load more until the application shows up.
    await expect(async () => {
      if (await applicant.isVisible()) return;
      const more = adminPage.getByRole('button', { name: 'Load more' });
      if (await more.isVisible()) await more.click();
      await expect(applicant).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await applicant.click();

    await expect(
      adminPage.getByRole('heading', { level: 1, name: new RegExp(student.displayName) }),
    ).toBeVisible();
    await adminPage.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = adminPage.getByRole('dialog', { name: 'Approve this application?' });
    await dialog.getByRole('button', { name: 'Approve application' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      adminPage.getByRole('heading', { level: 1, name: new RegExp(student.displayName) }),
    ).toContainText('Approved');
  });

  await test.step('the applicant receives the approval mail', async () => {
    const mail = await mailpit.waitForMail({ to: student.email, subject: SUBJECTS.approved });
    expect(mail.Text).toContain(urls.instructor);
  });

  await test.step('web-instructor login now succeeds and shows the dashboard', async () => {
    const instructorPage = await newPage();
    await logIn(instructorPage, 'instructor', student, '/');
    await expect(
      instructorPage.getByRole('heading', { name: `Welcome back, ${student.displayName}` }),
    ).toBeVisible();
  });
});
