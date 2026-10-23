import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';

import {
  bff,
  createE2eCategory,
  publishArticleCourse,
  type SeededCourse,
} from '../src/catalog-seed';
import { stripeEmulatorUrl, urls } from '../src/env';
import { expect, test } from '../src/fixtures';
import {
  becomeInstructor,
  loadMoreUntilVisible,
  logIn,
  signUp,
  verifyEmailFromMail,
} from '../src/flows';
import { E2E_COURSE_MARKER } from '../src/mailpit';

/*
 * Phase 4 commerce journey (design P4-T18) across the three apps, the api, the Stripe emulator,
 * the worker and Mailpit:
 *   the instructor prices a published course and creates a 50% coupon → an anonymous student
 *   sees the price, fills the guest cart, logs in (the cart is merged), applies the coupon,
 *   checks out and pays on the emulator's hosted page → PAID, a non-preview lecture opens and
 *   the receipt is mailed → the student asks for a refund (auto-approved: access ends at once,
 *   the emulator refunds) → the lecture is locked again → the admin sees the refund and the
 *   order timeline. A free course is enrolled with "Enroll for free".
 *
 * The courses are seeded through the instructor and admin BFFs with article lectures and a
 * stand-in course image (src/catalog-seed.ts), so nothing waits for the transcoder.
 */

const SUBJECTS = {
  receipt: (orderNumber: number) => `Your receipt for order #${orderNumber}`,
  refunded: 'Your refund was processed',
} as const;

const PRICE = { amount: '19.99', label: '$19.99' } as const;
/** 50% of 19.99, half up (D3): 10.00 off, 9.99 to pay. */
const DISCOUNTED = '$9.99';

/** Content-Security-Policy violations in a page's console (the journey asserts there are none). */
function collectCspViolations(page: Page, into: string[]): Page {
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      into.push(`${page.url()}: ${message.text()}`);
    }
  });
  return page;
}

/** The curriculum entry of a lecture: a button when it can be opened, plain text otherwise. */
const lectureButton = (page: Page, title: string) =>
  page.getByRole('button', { name: new RegExp(`^${title}`) });

test('commerce: price + coupon → guest cart → login merge → pay on the emulator → learn → refund → locked; free enroll', async ({
  newPage,
  users,
  mailpit,
  admin,
  db,
}) => {
  // Two seeded courses, a hosted payment, two webhooks and three emails on a shared dev stack.
  test.setTimeout(6 * 60_000);

  const id = randomBytes(4).toString('hex');
  const instructor = users.next('Instructor');
  const student = users.next('Student');
  const couponCode = `HALF${id.toUpperCase()}`;
  const cspViolations: string[] = [];
  let instructorPage!: Page;
  let adminPage!: Page;
  let studentPage!: Page;
  let paid!: SeededCourse;
  let free!: SeededCourse;
  let orderId!: string;
  let orderNumber!: number;

  await test.step('setup: an approved instructor, a verified student, two published courses', async () => {
    await becomeInstructor(newPage, mailpit, admin, instructor);

    const signup = await newPage();
    await signUp(signup, student);
    await verifyEmailFromMail(signup, mailpit, student);
    await signup.context().close();

    adminPage = collectCspViolations(await newPage(), cspViolations);
    await logIn(adminPage, 'admin', admin, '/instructor-applications');
    instructorPage = collectCspViolations(await newPage(), cspViolations);
    await logIn(instructorPage, 'instructor', instructor, '/');

    const categoryId = await createE2eCategory(adminPage, id);
    const seed = (suffix: string) =>
      publishArticleCourse({
        instructorPage,
        adminPage,
        db,
        ownerEmail: instructor.email,
        categoryId,
        title: `${E2E_COURSE_MARKER} ${id} ${suffix}`,
        slug: `e2e-commerce-${id}-${suffix}`,
      });
    paid = await seed('paid');
    free = await seed('free');
  });

  await test.step('instructor sets the price on the Pricing tab', async () => {
    const page = instructorPage;
    await page.goto(`${urls.instructor}/courses/${paid.id}`);
    await page.getByRole('tab', { name: 'Pricing' }).click();
    await expect(page.getByText('No price yet')).toBeVisible();
    await page.getByLabel('Price tier').selectOption({ label: PRICE.label });
    await page.getByRole('button', { name: 'Save price' }).click();
    await expect(page.getByText(`Price saved: ${PRICE.label}.`)).toBeVisible();
    await expect(page.getByText(`Current price: ${PRICE.label}`)).toBeVisible();

    // The second course is free (D14).
    await page.goto(`${urls.instructor}/courses/${free.id}`);
    await page.getByRole('tab', { name: 'Pricing' }).click();
    await page.getByLabel('Price tier').selectOption({ label: 'Free' });
    await page.getByRole('button', { name: 'Save price' }).click();
    await expect(page.getByText('Price saved: Free.')).toBeVisible();
  });

  await test.step('instructor creates a 50% coupon on the Promotions tab', async () => {
    const page = instructorPage;
    await page.goto(`${urls.instructor}/courses/${paid.id}`);
    await page.getByRole('tab', { name: 'Promotions' }).click();
    await page.getByRole('button', { name: 'Create coupon' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create coupon' });
    await dialog.getByLabel('Code').fill(couponCode);
    await dialog.getByRole('textbox', { name: 'Percent off' }).fill('50');
    await expect(
      dialog.getByText(`Students pay ${DISCOUNTED} instead of ${PRICE.label}.`),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Create coupon' }).click();
    await expect(dialog).toBeHidden();
    const row = page.locator(`tr[data-coupon-code="${couponCode}"]`);
    await expect(row).toContainText('50% off');
    await expect(row).toContainText('Active');
  });

  await test.step('an anonymous student finds the course with its price and fills the guest cart', async () => {
    studentPage = collectCspViolations(await newPage(), cspViolations);
    const page = studentPage;
    await page.goto(`${urls.student}/courses?q=${id}`);
    const card = page.getByTestId('course-card').filter({ hasText: paid.title });
    await expect(card.getByTestId('price')).toHaveText(PRICE.label);
    await card.getByRole('link', { name: paid.title }).click();
    await expect(page).toHaveURL(`${urls.student}/course/${paid.slug}`);

    const box = page.getByTestId('purchase-box');
    await expect(box).toHaveAttribute('data-state', 'add_to_cart');
    await expect(box.getByTestId('price')).toHaveText(PRICE.label);
    // Signed out, the non-preview lecture is not offered; the preview is.
    await expect(lectureButton(page, paid.preview.title)).toBeVisible();
    await expect(lectureButton(page, paid.locked.title)).toHaveCount(0);

    await box.getByRole('button', { name: 'Add to cart' }).click();
    await expect(box).toHaveAttribute('data-state', 'in_cart');
    await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();

    await box.getByRole('link', { name: 'Go to cart' }).click();
    await expect(page).toHaveURL(`${urls.student}/cart`);
    const line = page.getByTestId('cart-line');
    await expect(line.getByRole('link', { name: paid.title })).toBeVisible();
    await expect(line).toContainText(PRICE.label);
    await expect(page.getByTestId('cart-total')).toHaveText(PRICE.label);
  });

  await test.step('the student logs in from the cart: the guest cart is merged into the server cart', async () => {
    const page = studentPage;
    await page.getByRole('link', { name: 'Log in to check out' }).click();
    await expect(page).toHaveURL(`${urls.student}/login?next=%2Fcart`);
    await page.getByLabel('Email').fill(student.email);
    await page.getByLabel('Password', { exact: true }).fill(student.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(`${urls.student}/cart`);

    // The server cart (with a "Checkout" button) holds the course; localStorage is emptied.
    await expect(page.getByRole('button', { name: 'Checkout' })).toBeVisible();
    await expect(
      page.getByTestId('cart-line').getByRole('link', { name: paid.title }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('udemy.guest-cart.v1')))
      .toBeNull();
    await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
  });

  await test.step('the student applies the 50% coupon', async () => {
    const page = studentPage;
    await page.getByLabel('Coupon code').fill(couponCode.toLowerCase());
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(`${couponCode} is applied`)).toBeVisible();
    await expect(page.getByTestId('line-final')).toHaveText(DISCOUNTED);
    await expect(page.getByTestId('line-list')).toHaveText(PRICE.label);
    await expect(page.getByTestId('cart-total')).toHaveText(DISCOUNTED);
  });

  await test.step('checkout hands off to the emulator; paying there lands on PAID', async () => {
    const page = studentPage;
    await page.getByRole('button', { name: 'Checkout' }).click();
    // The hosted payment page (an allowed CHECKOUT_ALLOWED_ORIGINS origin, a different site).
    await page.waitForURL(
      (url) => url.origin === stripeEmulatorUrl && url.pathname.startsWith('/pay/'),
    );
    await page.getByRole('button', { name: 'Pay', exact: true }).click();

    await page.waitForURL(
      (url) => url.origin === urls.student && url.pathname === '/checkout/success',
    );
    orderId = new URL(page.url()).searchParams.get('orderId') ?? '';
    expect(orderId).toMatch(/^[0-9a-f-]{36}$/);
    const paidCard = page.getByTestId('checkout-paid');
    // The webhook settles the order; the page polls until PAID.
    await expect(paidCard.getByText("You're enrolled")).toBeVisible({ timeout: 60_000 });
    const text = (await paidCard.textContent()) ?? '';
    orderNumber = Number(/order #(\d+)/.exec(text)?.[1]);
    expect(orderNumber).toBeGreaterThan(0);
    await expect(paidCard).toContainText(DISCOUNTED);
    // The paid lines left the cart.
    await expect(page.getByRole('link', { name: 'Cart', exact: true })).toBeVisible();
  });

  await test.step('the receipt is mailed (outbox → Kafka → worker → Mailpit)', async () => {
    const mail = await mailpit.waitForMail({
      to: student.email,
      subject: SUBJECTS.receipt(orderNumber),
    });
    expect(mail.Text).toContain(paid.title);
    expect(mail.Text).toContain(DISCOUNTED);
  });

  await test.step('the enrolled student opens a non-preview lecture', async () => {
    const page = studentPage;
    await page.getByTestId('checkout-paid').getByRole('link', { name: 'Go to course' }).click();
    await expect(page).toHaveURL(`${urls.student}/course/${paid.slug}`);
    await expect(page.getByTestId('purchase-box')).toHaveAttribute('data-state', 'enrolled');
    await lectureButton(page, paid.locked.title).click();
    const dialog = page.getByRole('dialog', { name: paid.locked.title });
    await expect(dialog.getByRole('heading', { name: paid.lockedBody })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.goto(`${urls.student}/my-learning`);
    await expect(page.getByTestId('learning-card').filter({ hasText: paid.title })).toBeVisible();
  });

  await test.step('the student requests a refund: auto-approved, then refunded by the emulator', async () => {
    const page = studentPage;
    await page.goto(`${urls.student}/account/orders/${orderId}`);
    await expect(page.getByRole('heading', { name: `Order #${orderNumber}` })).toBeVisible();
    const line = page.getByTestId('order-line').filter({ hasText: paid.title });
    await line.getByRole('button', { name: 'Request refund' }).click();
    const dialog = page.getByRole('dialog', { name: 'Request a refund' });
    await dialog.getByLabel('Reason').selectOption({ label: 'I bought it by accident' });
    await dialog.getByLabel('Comment').fill('Bought the wrong course, sorry.');
    await dialog.getByRole('button', { name: 'Request refund' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Your refund for "${paid.title}" is approved.`)).toBeVisible();

    // The dispatcher submits it to the emulator; its refund webhook settles it (SUCCEEDED).
    await mailpit.waitForMail({ to: student.email, subject: SUBJECTS.refunded });
    await page.reload();
    await expect(line.getByTestId('refund-status')).toHaveText('Refunded');
    await expect(page.getByTestId('order-status')).toHaveText('Refunded');
  });

  await test.step('the lecture is locked again', async () => {
    const page = studentPage;
    await page.goto(`${urls.student}/course/${paid.slug}`);
    const box = page.getByTestId('purchase-box');
    // Not enrolled any more: the course can be bought again.
    await expect(box).toHaveAttribute('data-state', 'add_to_cart');
    await expect(lectureButton(page, paid.preview.title)).toBeVisible();
    await expect(lectureButton(page, paid.locked.title)).toHaveCount(0);
    // And the api agrees: the article itself is refused for this signed-in student.
    const article = await bff<{ code: string }>(
      page,
      'GET',
      `/catalog/courses/${paid.id}/lectures/${paid.locked.id}/article`,
    );
    expect(article.status).toBe(403);
    expect(article.body.code).toBe('lecture_locked');
  });

  await test.step('the admin sees the refund and the order timeline', async () => {
    const page = adminPage;
    await page.goto(`${urls.admin}/orders/${orderId}`);
    await expect(
      page.getByRole('heading', { level: 1, name: new RegExp(`Order #${orderNumber}`) }),
    ).toContainText('Refunded');
    const refunds = page.getByRole('table', { name: 'Refunds of this order' });
    const refundRow = refunds.getByTestId('refund-row').filter({ hasText: paid.title });
    await expect(refundRow).toContainText('Refunded');
    await expect(refundRow).toContainText('I bought it by accident');

    const timeline = page.getByRole('list', { name: 'Order timeline' });
    await expect(
      timeline.getByRole('listitem').filter({ hasText: 'Pending payment → Paid' }),
    ).toBeVisible();
    await expect(
      timeline
        .getByRole('listitem')
        .filter({ hasText: `Refund (${paid.title})` })
        .last(),
    ).toContainText('Refunded');
    await expect(
      timeline.getByRole('listitem').filter({ hasText: 'Paid → Refunded' }),
    ).toBeVisible();

    // The refunds page lists it under "Refunded".
    await page.goto(`${urls.admin}/refunds?status=SUCCEEDED`);
    const queueRow = page
      .getByRole('table', { name: 'Refunds' })
      .getByTestId('refund-row')
      .filter({ hasText: `Order #${orderNumber}` });
    await loadMoreUntilVisible(page, queueRow);
    await expect(queueRow).toContainText(student.email);
  });

  await test.step('the ledger recorded the sale and the refund (worker)', async () => {
    // Also keeps the cleanup from racing the ledger writer.
    await expect
      .poll(
        async () =>
          (
            await db.query<{ kind: string }>(
              `select e.kind from payouts.journal_entries e
                 join commerce.order_lines l on l.id = e.order_line_id
                where l.order_id = $1 order by e.kind`,
              [orderId],
            )
          ).rows.map((r) => r.kind),
        { timeout: 45_000 },
      )
      .toEqual(['REFUND', 'SALE']);
  });

  await test.step('a free course offers "Enroll for free" and enrolls at once', async () => {
    const page = studentPage;
    await page.goto(`${urls.student}/course/${free.slug}`);
    const box = page.getByTestId('purchase-box');
    await expect(box).toHaveAttribute('data-state', 'free');
    await expect(box.getByTestId('price')).toHaveText('Free');
    await box.getByRole('button', { name: 'Enroll for free' }).click();
    await expect(box).toHaveAttribute('data-state', 'enrolled');
    await expect(box.getByRole('link', { name: 'Go to course' })).toBeVisible();
    await lectureButton(page, free.locked.title).click();
    await expect(
      page
        .getByRole('dialog', { name: free.locked.title })
        .getByRole('heading', { name: free.lockedBody }),
    ).toBeVisible();

    await page.goto(`${urls.student}/my-learning`);
    await expect(page.getByTestId('learning-card').filter({ hasText: free.title })).toBeVisible();
    await expect(page.getByTestId('learning-card').filter({ hasText: paid.title })).toHaveCount(0);
  });

  expect(cspViolations).toEqual([]);
});
