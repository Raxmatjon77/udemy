import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';

import { mediaPublicOrigin, urls } from '../src/env';
import { expect, test } from '../src/fixtures';
import { becomeInstructor, loadMoreUntilVisible, logIn, SUBJECTS } from '../src/flows';
import { E2E_COURSE_MARKER } from '../src/mailpit';
import { MEDIA_FIXTURES } from '../src/media-fixtures';

/*
 * Phase 2 course lifecycle (design P2-T19) across the three apps, the api, the worker, the
 * transcoder, MinIO and Mailpit:
 *   instructor builds a course (details, image, a video lecture processed to READY and marked as
 *   free preview, an article) → submits → admin plays the video and rejects → instructor fixes and
 *   resubmits → admin approves → an anonymous student finds it, watches the preview (HLS segments
 *   from MinIO through signed URLs, CORS and CSP) → the instructor's later edit stays invisible
 *   until an admin approves the update (snapshot model, with a before/after diff).
 *
 * Runs in Google Chrome (project `chrome`, playwright.config.ts): H.264/AAC playback.
 */

/** Uploads are processed asynchronously: worker enqueue → transcoder (~10–60 s for 5 s of video). */
const PROCESSING_TIMEOUT_MS = 180_000;

/** An HLS media segment served by MinIO through a presigned URL (`…/seg_00000.ts?X-Amz-…`). */
function isSegmentUrl(url: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.origin === mediaPublicOrigin &&
    parsed.pathname.endsWith('.ts') &&
    parsed.searchParams.has('X-Amz-Signature')
  );
}

/** Resolves with the first HLS segment fetched from MinIO with status 200. */
function waitForSegment(page: Page, timeout = 60_000) {
  return page.waitForResponse(
    (response) => isSegmentUrl(response.url()) && response.status() === 200,
    { timeout },
  );
}

/** The segment arrived AND was decoded: the video plays (muted, so autoplay rules allow it). */
async function expectVideoPlays(video: Locator): Promise<void> {
  await expect(video).toBeVisible();
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
}

/** An `<img>` that finished loading real pixels (the signed-redirect route → MinIO). */
async function expectImageLoaded(image: Locator): Promise<void> {
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    )
    .toBe(true);
}

/**
 * Collects Content-Security-Policy violations a page reports in its console (blocked segment,
 * image or worker loads would show up here first): the journey asserts there are none.
 */
function collectCspViolations(page: Page, into: string[]): Page {
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      into.push(`${page.url()}: ${message.text()}`);
    }
  });
  return page;
}

test('course lifecycle: build → review → reject → resubmit → approve → public preview → update', async ({
  newPage,
  users,
  mailpit,
  admin,
}) => {
  // Two transcodes, three reviews and seven emails on a shared dev stack.
  test.setTimeout(10 * 60_000);

  const id = randomBytes(4).toString('hex');
  const instructor = users.next('Instructor');
  const category = { group: `E2E Group ${id}`, topic: `E2E Topic ${id}` };
  const course = {
    title: `${E2E_COURSE_MARKER} ${id} lifecycle`,
    updatedTitle: `${E2E_COURSE_MARKER} ${id} lifecycle, 2nd edition`,
    slug: `e2e-course-${id}`,
    subtitle: 'Build, review and publish a course from the first upload',
    fixedSubtitle: 'Build, review and publish a course, from the first upload to students',
    description:
      '## What this course covers\n\n' +
      'This course walks through **the whole publishing workflow** of the platform: writing the ' +
      'course details, uploading a lecture video, adding an article, and sending the result to ' +
      'a moderator. Every step is checked by an automated end-to-end journey, so the text is ' +
      'long enough for the readiness rules.\n\n- uploads\n- reviews\n- previews',
    outcomes: [
      'Write a course description in markdown',
      'Upload and process a lecture video',
      'Publish a free preview lecture',
      'Respond to a moderator review',
    ],
    requirements: ['A modern web browser'],
    section: 'Getting started',
    video: 'Welcome to the course',
    article: 'Reading list',
    articleBody:
      '## Further reading\n\nRead the [HLS overview](https://developer.apple.com/streaming/) ' +
      'before the next lecture, and keep these notes:\n\n1. segments\n2. playlists\n',
  };
  const rejectionReason =
    'The subtitle should say who the course is for. Please make it more specific and resubmit.';

  const cspViolations: string[] = [];
  let instructorPage!: Page;
  let adminPage!: Page;
  let courseUrl!: string;

  await test.step('setup: a verified student applies and the e2e admin approves (instructor)', async () => {
    await becomeInstructor(newPage, mailpit, admin, instructor);
  });

  await test.step('setup: the admin creates a category group and a subcategory', async () => {
    adminPage = collectCspViolations(await newPage(), cspViolations);
    await logIn(adminPage, 'admin', admin, '/instructor-applications');
    await adminPage.goto(`${urls.admin}/categories`);

    await adminPage.getByRole('button', { name: 'Add group' }).click();
    let dialog = adminPage.getByRole('dialog', { name: 'Add a group' });
    await dialog.getByLabel('Name').fill(category.group);
    await dialog.getByLabel('Slug').fill(`e2e-group-${id}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toBeHidden();

    await adminPage.getByRole('button', { name: `Add subcategory to ${category.group}` }).click();
    dialog = adminPage.getByRole('dialog', { name: `Add a subcategory to “${category.group}”` });
    await dialog.getByLabel('Name').fill(category.topic);
    await dialog.getByLabel('Slug').fill(`e2e-topic-${id}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      adminPage
        .getByRole('list', { name: `Subcategories of ${category.group}` })
        .getByText(category.topic, { exact: true }),
    ).toBeVisible();
  });

  await test.step('instructor creates the course in web-instructor', async () => {
    instructorPage = collectCspViolations(await newPage(), cspViolations);
    await logIn(instructorPage, 'instructor', instructor, '/');
    await instructorPage.goto(`${urls.instructor}/courses`);
    await instructorPage.getByRole('link', { name: 'Create course' }).click();
    await instructorPage.getByLabel('Working title').fill(course.title);
    await instructorPage.getByLabel('Category').selectOption({ label: category.topic });
    await instructorPage.getByRole('button', { name: 'Create course' }).click();
    await expect(instructorPage).toHaveURL(/\/courses\/[0-9a-f-]{36}$/);
    courseUrl = instructorPage.url();
    await expect(
      instructorPage.getByRole('heading', { level: 1, name: course.title }),
    ).toBeVisible();
  });

  await test.step('instructor fills in the details (markdown, outcomes, requirements, level, language)', async () => {
    const page = instructorPage;
    await page.getByLabel('Subtitle').fill(course.subtitle);
    await page.getByRole('textbox', { name: 'Description' }).fill(course.description);
    // The live preview renders the markdown with the students' renderer.
    await expect(
      page.getByRole('region', { name: 'Description preview' }).getByRole('heading', {
        name: 'What this course covers',
      }),
    ).toBeVisible();
    await page.getByLabel('Language').selectOption({ label: 'English' });
    await page.getByLabel('Level').selectOption({ label: 'Beginner' });
    await expect(page.getByLabel('Category')).toHaveValue(/[0-9a-f-]{36}/);
    await page.getByLabel('Course URL').fill(course.slug);
    for (const [index, outcome] of course.outcomes.entries()) {
      await page.getByRole('button', { name: 'Add outcome' }).click();
      await page.getByLabel(`Outcome ${index + 1}`, { exact: true }).fill(outcome);
    }
    for (const [index, requirement] of course.requirements.entries()) {
      await page.getByRole('button', { name: 'Add requirement' }).click();
      await page.getByLabel(`Requirement ${index + 1}`, { exact: true }).fill(requirement);
    }
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText('All changes saved.')).toBeVisible();
  });

  await test.step('instructor uploads the course image; it is processed and shown', async () => {
    const image = instructorPage.getByRole('region', { name: 'Course image' });
    await image.getByLabel('Upload image').setInputFiles(MEDIA_FIXTURES.thumbnail);
    await expect(image.getByText('Ready', { exact: true })).toBeVisible({
      timeout: PROCESSING_TIMEOUT_MS,
    });
    // Signed-redirect route → presigned MinIO URL: proves img-src and the signature.
    await expectImageLoaded(image.getByRole('img', { name: 'Current course image' }));
  });

  await test.step('instructor adds a section and a video lecture, uploads the video, waits for READY', async () => {
    const page = instructorPage;
    await page.getByRole('tab', { name: 'Curriculum' }).click();
    await page.getByLabel('New section').fill(course.section);
    await page.getByRole('button', { name: 'Add section' }).click();
    await expect(page.getByRole('heading', { name: `Section 1: ${course.section}` })).toBeVisible();

    await page.getByLabel('Lecture type for section 1').selectOption({ label: 'Video' });
    await page.getByLabel('New lecture title for section 1').fill(course.video);
    await page.getByRole('button', { name: 'Add lecture' }).click();
    await page.getByRole('button', { name: `Lecture 1: ${course.video}`, exact: true }).click();

    const drawer = page.getByRole('dialog', { name: course.video });
    // The owner preview player mounts (and fetches the first segment) as soon as it is READY.
    const segment = waitForSegment(page, PROCESSING_TIMEOUT_MS + 60_000);
    await drawer.getByLabel('Upload video').setInputFiles(MEDIA_FIXTURES.video);
    await expect(drawer.getByText(/Upload of lecture-5s\.mp4 complete/)).toBeVisible({
      timeout: 60_000,
    });
    // UPLOADED → (outbox → Kafka → worker enqueues) → transcoder PROCESSING → READY.
    await expect(drawer.getByText('Ready', { exact: true })).toBeVisible({
      timeout: PROCESSING_TIMEOUT_MS,
    });
    await expect(drawer.getByText(/0:05|5 s|00:05/)).toBeVisible();

    // The owner preview player (working-copy playlists) streams it from MinIO.
    await segment;
    await expectVideoPlays(drawer.getByLabel(course.video, { exact: true }));
  });

  await test.step('instructor marks the video as a free preview', async () => {
    const drawer = instructorPage.getByRole('dialog', { name: course.video });
    // A controlled checkbox: it shows the server's state, so it flips once the PATCH succeeded.
    await drawer.getByLabel('Free preview').click();
    await expect(drawer.getByLabel('Free preview')).toBeChecked();
    await instructorPage.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(
      instructorPage
        .getByRole('list', { name: 'Lectures of section 1' })
        .getByRole('listitem')
        .filter({ hasText: course.video })
        .getByText('Preview', { exact: true }),
    ).toBeVisible();
  });

  await test.step('instructor adds an article lecture with markdown', async () => {
    const page = instructorPage;
    await page.getByLabel('Lecture type for section 1').selectOption({ label: 'Article' });
    await page.getByLabel('New lecture title for section 1').fill(course.article);
    await page.getByRole('button', { name: 'Add lecture' }).click();
    await page.getByRole('button', { name: `Lecture 2: ${course.article}`, exact: true }).click();

    const drawer = page.getByRole('dialog', { name: course.article });
    await drawer.getByRole('textbox', { name: 'Article' }).fill(course.articleBody);
    await expect(
      drawer.getByRole('region', { name: 'Article preview' }).getByRole('link', {
        name: 'HLS overview',
      }),
    ).toBeVisible();
    await drawer.getByRole('button', { name: 'Save article' }).click();
    await expect(drawer.getByText('Article saved.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  await test.step('instructor: the readiness panel is clear; submit for review', async () => {
    const page = instructorPage;
    await page.getByRole('tab', { name: /^Review/ }).click();
    await expect(page.getByText('Ready for review')).toBeVisible();
    await page.getByLabel(/Note to the reviewer/).fill('First version, ready for a look.');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText(/^Version 1, submitted /)).toBeVisible();
    // The form gives way to the locked state once the course is refetched (D2: read-only).
    await expect(page.getByRole('heading', { name: 'Waiting for a moderator' })).toBeVisible();
  });

  await test.step('mail: every admin (the e2e admin included) is asked for a review', async () => {
    const mail = await mailpit.waitForMail({
      to: admin.email,
      subject: SUBJECTS.reviewRequested(course.title),
    });
    expect(mail.Text).toContain(`${urls.admin}/course-reviews/`);
  });

  await test.step('admin opens the queue and the revision, and plays the video', async () => {
    const page = adminPage;
    await page.goto(`${urls.admin}/course-reviews`);
    const link = page.getByRole('link', { name: course.title, exact: true });
    await loadMoreUntilVisible(page, link);
    await link.click();
    await expect(
      page.getByRole('heading', { level: 1, name: new RegExp(course.title) }),
    ).toBeVisible();
    await expect(page.getByText(/^Revision 1 by/)).toBeVisible();

    const segment = waitForSegment(page);
    await page.getByRole('button', { name: `Play ${course.video}` }).click();
    expect((await segment).status()).toBe(200);
    await expectVideoPlays(page.getByLabel(course.video, { exact: true }));
  });

  await test.step('admin rejects the revision with a reason', async () => {
    const page = adminPage;
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reject this revision?' });
    await dialog.getByLabel('Reason').fill(rejectionReason);
    await dialog.getByRole('button', { name: 'Reject revision' }).click();
    await expect(
      page.getByText('Rejected. The instructor was notified with your reason.'),
    ).toBeVisible();
  });

  await test.step('mail: the instructor receives the rejection with the reason', async () => {
    const mail = await mailpit.waitForMail({
      to: instructor.email,
      subject: SUBJECTS.courseRejected,
    });
    expect(mail.Text).toContain(rejectionReason);
  });

  await test.step('instructor sees the reason, fixes the subtitle and resubmits', async () => {
    const page = instructorPage;
    await page.goto(courseUrl);
    await page.getByRole('tab', { name: /^Review/ }).click();
    await expect(page.getByText('Version 1 was not approved')).toBeVisible();
    await expect(page.getByText(rejectionReason, { exact: true }).first()).toBeVisible();

    await page.getByRole('tab', { name: 'Details' }).click();
    await page.getByLabel('Subtitle').fill(course.fixedSubtitle);
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText('All changes saved.')).toBeVisible();

    await page.getByRole('tab', { name: /^Review/ }).click();
    await expect(page.getByText('Ready for review')).toBeVisible();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText(/^Version 2, submitted /)).toBeVisible();
  });

  await test.step('admin opens revision 2 (still the first publication: nothing to diff) and approves', async () => {
    const page = adminPage;
    await page.goto(`${urls.admin}/course-reviews`);
    const link = page.getByRole('link', { name: course.title, exact: true });
    await loadMoreUntilVisible(page, link);
    await link.click();
    await expect(page.getByText(/^Revision 2 by/)).toBeVisible();
    // A rejected first submission never went live: the diff base is the live revision (none).
    await expect(
      page.getByText(/This is the first submission of this course, so there is no live version/),
    ).toBeVisible();
    await expect(page.getByText(course.fixedSubtitle)).toBeVisible();

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve this revision?' });
    await dialog.getByRole('button', { name: 'Approve and publish' }).click();
    await expect(page.getByText('Approved. This revision is now live for students.')).toBeVisible();
  });

  await test.step('mail: the instructor is told the course is live', async () => {
    const mail = await mailpit.waitForMail({
      to: instructor.email,
      subject: SUBJECTS.coursePublished,
    });
    expect(mail.Text).toContain(`${urls.student}/course/${course.slug}`);
  });

  const student = collectCspViolations(await newPage(), cspViolations);

  await test.step('anonymous student finds the course via browse and opens the landing page', async () => {
    await student.goto(`${urls.student}/courses`);
    await student.getByLabel('Search').fill(id);
    await student.getByRole('button', { name: 'Search' }).click();
    const card = student.getByTestId('course-card').filter({ hasText: course.title });
    await expect(card).toHaveCount(1);
    await card.getByRole('link', { name: course.title }).click();
    await expect(student).toHaveURL(`${urls.student}/course/${course.slug}`);

    await expect(student.getByRole('heading', { level: 1, name: course.title })).toBeVisible();
    await expect(student.getByText(course.fixedSubtitle)).toBeVisible();
    for (const outcome of course.outcomes) await expect(student.getByText(outcome)).toBeVisible();
    await expect(student.getByText(course.requirements[0]!)).toBeVisible();
    await expect(student.getByRole('heading', { name: 'What this course covers' })).toBeVisible();
    await expect(student.getByTestId('instructor-card')).toContainText(instructor.displayName);
    await expect(student.getByTestId('curriculum-totals')).toContainText('2 lectures');
    // Phase 4 replaced the "Enrollment opens soon" placeholder with the purchase box. This course
    // has no price (not for sale). While the commerce API is being built the price lookup can fail,
    // which renders "Enrollment unavailable" instead; the exact purchase states are asserted by the
    // Phase 4 checkout journey against the real commerce API.
    await expect(
      student
        .getByTestId('purchase-box')
        .or(student.getByRole('button', { name: 'Enrollment unavailable' })),
    ).toBeVisible();
  });

  await test.step('student plays the free preview: an HLS segment loads from MinIO (200)', async () => {
    const segment = waitForSegment(student);
    await student.getByRole('button', { name: new RegExp(`^${course.video}`) }).click();
    const dialog = student.getByRole('dialog', { name: course.video });
    await expect(dialog).toBeVisible();
    expect((await segment).status()).toBe(200);
    await expectVideoPlays(dialog.getByLabel(course.video, { exact: true }));
    await student.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  await test.step('student: the article (not a preview) is locked', async () => {
    const row = student.getByTestId('lecture-row').filter({ hasText: course.article });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  await test.step('instructor renames the course without resubmitting: the landing keeps the old title', async () => {
    const page = instructorPage;
    await page.goto(courseUrl);
    await page.getByLabel('Title', { exact: true }).fill(course.updatedTitle);
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText('All changes saved.')).toBeVisible();
    // The badge next to the title: the working copy differs from the live revision.
    await expect(page.getByText('Unpublished changes', { exact: true }).first()).toBeVisible();

    await student.reload();
    await expect(student.getByRole('heading', { level: 1, name: course.title })).toBeVisible();
    await expect(student.getByText(course.updatedTitle)).toHaveCount(0);
  });

  await test.step('instructor submits the update; admin sees the before/after diff and approves', async () => {
    await instructorPage.getByRole('tab', { name: /^Review/ }).click();
    await instructorPage.getByRole('button', { name: 'Submit for review' }).click();
    await expect(instructorPage.getByText(/^Version 3, submitted /)).toBeVisible();

    const page = adminPage;
    await page.goto(`${urls.admin}/course-reviews`);
    const link = page.getByRole('link', { name: course.updatedTitle, exact: true });
    await loadMoreUntilVisible(page, link);
    await link.click();
    await expect(page.getByText(/^Revision 3 by/)).toBeVisible();
    const change = page
      .getByRole('list', { name: 'Changed details' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Title', exact: true }) });
    await expect(change.getByRole('definition').first()).toHaveText(course.title);
    await expect(change.getByRole('definition').last()).toHaveText(course.updatedTitle);

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve this revision?' });
    await dialog.getByRole('button', { name: 'Approve and publish' }).click();
    await expect(page.getByText('Approved. This revision is now live for students.')).toBeVisible();

    await student.reload();
    await expect(
      student.getByRole('heading', { level: 1, name: course.updatedTitle }),
    ).toBeVisible();
  });

  await test.step('mail: review requests for both submissions and the update-live mail arrive', async () => {
    for (const title of [course.title, course.updatedTitle]) {
      await mailpit.waitForMail({ to: admin.email, subject: SUBJECTS.reviewRequested(title) });
    }
    await mailpit.waitForMail({ to: instructor.email, subject: SUBJECTS.courseUpdatePublished });
  });

  await test.step('no Content-Security-Policy violation in any of the three apps', () => {
    expect(cspViolations).toEqual([]);
  });
});
