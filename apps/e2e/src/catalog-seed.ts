import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type pg from 'pg';

import { userIdsByEmail } from './db';
import { expect } from './fixtures';

/**
 * Seeds PUBLISHED courses for the journeys that are not about building one (Phase 4 commerce),
 * through the same BFF routes the instructor and admin apps call, so the catalog rules
 * (readiness, submit, approve, live revision) all run for real.
 *
 * The one shortcut is media: a course image must be READY before a course can be submitted,
 * and only the transcoder makes it READY. The commerce journey must not depend on a transcode
 * (no transcoder runs on small dev machines), so `insertReadyThumbnail` stands in for it with
 * the rows the transcoder would leave (like `insertTestAsset` of apps/api's catalog tests),
 * without renditions: the course then simply has no servable image (`hasThumbnail: false`).
 * The curriculum is ARTICLE lectures only (no video to process).
 */

/** The JSON answer of a BFF call made from the page (with its cookies and Origin). */
export interface BffResponse<T> {
  status: number;
  body: T;
}

/**
 * Calls `/api/proxy{path}` of the app `page` is on, from inside the page: the browser sends the
 * session cookies and the Origin header the BFF's CSRF rule checks.
 */
export async function bff<T = unknown>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<BffResponse<T>> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/api/proxy${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : JSON.parse(text) };
    },
    { method, path, body },
  ) as Promise<BffResponse<T>>;
}

/** Like `bff`, but fails the test unless the status is `expected`. */
export async function bffOk<T = unknown>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  expected: number,
): Promise<T> {
  const response = await bff<T>(page, method, path, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(expected);
  return response.body;
}

/** An `e2e-…` category group with one subcategory (global teardown deletes `e2e-` slugs). */
export async function createE2eCategory(adminPage: Page, id: string): Promise<string> {
  const group = await bffOk<{ id: string }>(
    adminPage,
    'POST',
    '/admin/categories',
    { name: `E2E Group ${id}`, slug: `e2e-group-${id}` },
    201,
  );
  const leaf = await bffOk<{ id: string }>(
    adminPage,
    'POST',
    '/admin/categories',
    { name: `E2E Topic ${id}`, slug: `e2e-topic-${id}`, parentId: group.id },
    201,
  );
  return leaf.id;
}

/**
 * A READY `COURSE_THUMBNAIL` asset of `ownerId`, walked through the legal status edges
 * (UPLOADING → UPLOADED → PROCESSING → READY) as the upload flow and the transcoder would.
 */
export async function insertReadyThumbnail(pool: pg.Pool, ownerId: string): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into media.assets
         (id, owner_id, purpose, original_filename, declared_content_type, declared_size_bytes,
          part_size_bytes, part_count, source_key, s3_upload_id)
       values ($1, $2, 'COURSE_THUMBNAIL', 'cover.png', 'image/png', 10000000, 8388608, 2, $3, $4)`,
      [id, ownerId, `uploads/${ownerId}/${id}/source`, `e2e-${id}`],
    );
    await client.query(
      `update media.assets set status = 'UPLOADED', s3_upload_id = null, uploaded_at = now()
        where id = $1`,
      [id],
    );
    await client.query(`update media.assets set status = 'PROCESSING' where id = $1`, [id]);
    await client.query(
      `update media.assets
          set status = 'READY', output_prefix = $2, ready_at = now(),
              width = 1280, height = 720, detected_format = 'png'
        where id = $1`,
      [id, `assets/${id}/a1/`],
    );
    await client.query('commit');
    return id;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface SeededLecture {
  id: string;
  title: string;
}

export interface SeededCourse {
  id: string;
  slug: string;
  title: string;
  /** ARTICLE, free preview. */
  preview: SeededLecture;
  /** ARTICLE, not a preview: only entitled viewers may open it. */
  locked: SeededLecture;
  lockedBody: string;
}

const DESCRIPTION =
  'This course is seeded by the commerce end-to-end journey. It covers **pricing, coupons, ' +
  'checkout and refunds** from the point of view of a student who buys a course, learns from ' +
  'it and changes their mind. The text is long enough for the readiness rules of the catalog.';

/**
 * Builds a course through the instructor BFF (details, the stand-in image, one section with a
 * preview article and a locked article), submits it and approves it through the admin BFF.
 * `instructorPage` and `adminPage` must be signed in and on their apps.
 */
export async function publishArticleCourse(options: {
  instructorPage: Page;
  adminPage: Page;
  db: pg.Pool;
  ownerEmail: string;
  categoryId: string;
  title: string;
  slug: string;
}): Promise<SeededCourse> {
  const { instructorPage: page, adminPage, title, slug } = options;
  const [ownerId] = await userIdsByEmail(options.db, [options.ownerEmail]);
  if (!ownerId) throw new Error(`No user ${options.ownerEmail}`);

  const course = await bffOk<{ id: string }>(
    page,
    'POST',
    '/instructor/courses',
    { title, categoryId: options.categoryId },
    201,
  );
  const base = `/courses/${course.id}`;
  await bffOk(
    page,
    'PATCH',
    base,
    {
      subtitle: 'Buy it, learn from it, get a refund',
      descriptionMd: DESCRIPTION,
      language: 'en',
      level: 'BEGINNER',
      slug,
      outcomes: ['Find a course', 'Apply a coupon', 'Pay at checkout', 'Request a refund'],
    },
    200,
  );
  await bffOk(
    page,
    'PUT',
    `${base}/thumbnail`,
    { assetId: await insertReadyThumbnail(options.db, ownerId) },
    200,
  );
  const section = await bffOk<{ id: string }>(
    page,
    'POST',
    `${base}/sections`,
    { title: 'Getting started' },
    201,
  );
  const article = async (lectureTitle: string, bodyMd: string, isPreview: boolean) => {
    const lecture = await bffOk<{ id: string }>(
      page,
      'POST',
      `${base}/sections/${section.id}/lectures`,
      { type: 'ARTICLE', title: lectureTitle },
      201,
    );
    await bffOk(page, 'PUT', `${base}/lectures/${lecture.id}/article`, { bodyMd }, 200);
    if (isPreview) {
      await bffOk(page, 'PATCH', `${base}/lectures/${lecture.id}`, { isPreview: true }, 200);
    }
    return { id: lecture.id, title: lectureTitle };
  };
  const preview = await article(
    'Welcome and course map',
    '## Welcome\n\nThis free preview explains what the course covers and how it is organised.',
    true,
  );
  const lockedBody = `Members-only notes ${randomUUID().slice(0, 8)}`;
  const locked = await article(
    'Members-only notes',
    `## ${lockedBody}\n\nOnly enrolled students can read this lecture: it is not a free preview.`,
    false,
  );

  const { revisionId } = await bffOk<{ revisionId: string }>(
    page,
    'POST',
    `${base}/submit`,
    {},
    200,
  );
  const approved = await bffOk<{ status: string; slug: string }>(
    adminPage,
    'POST',
    `/admin/courses/${course.id}/revisions/${revisionId}/approve`,
    {},
    200,
  );
  expect(approved.status).toBe('PUBLISHED');
  return { id: course.id, slug: approved.slug, title, preview, locked, lockedBody };
}
