import { randomBytes, randomInt } from 'node:crypto';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type pg from 'pg';

import { deleteUsersAndMedia } from './cleanup';
import { createPool, userIdsByEmail } from './db';
import { Mailpit, E2E_ADDRESS_PREFIX } from './mailpit';

export { expect };

export interface TestUser {
  email: string;
  password: string;
  displayName: string;
}

export interface AdminCredentials {
  userId: string;
  email: string;
  password: string;
  displayName: string;
}

export interface UserFactory {
  /** A fresh, unused identity (`e2e-<random>@example.test`); deleted after the test. */
  next(label?: string): TestUser;
}

interface TestFixtures {
  /**
   * The end-user IP of this test, sent as `X-Real-IP`. The BFFs forward it to the API as
   * `X-Client-IP`, which keys the per-IP rate limits (signup 10/h, login 30/10 min, forgot 10/h).
   * One random address per test keeps repeated runs from tripping them, like distinct users.
   */
  clientIp: string;
  /** A new browser context (own cookie jar) with this test's client IP; closed after the test. */
  newContext: () => Promise<BrowserContext>;
  /** A page in a new context. */
  newPage: () => Promise<Page>;
  users: UserFactory;
  admin: AdminCredentials;
}

interface WorkerFixtures {
  mailpit: Mailpit;
  db: pg.Pool;
}

/** The fixtures a journey body uses, so a journey can be a plain function run by two tests. */
export type JourneyFixtures = Pick<TestFixtures, 'newContext' | 'newPage' | 'users' | 'admin'> &
  WorkerFixtures & { page: Page };

/** 198.18.0.0/15 is reserved for benchmarking (RFC 2544): never a real client. */
function randomTestIp(): string {
  return `198.${18 + randomInt(2)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  clientIp: async ({}, use) => {
    await use(randomTestIp());
  },

  extraHTTPHeaders: async ({ clientIp }, use) => {
    await use({ 'x-real-ip': clientIp });
  },

  newContext: async ({ browser, contextOptions, clientIp }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext({
        ...contextOptions,
        extraHTTPHeaders: { 'x-real-ip': clientIp },
      });
      contexts.push(context);
      return context;
    });
    for (const context of contexts) await context.close();
  },

  newPage: async ({ newContext }, use) => {
    await use(async () => (await newContext()).newPage());
  },

  mailpit: [
    async ({}, use) => {
      await use(new Mailpit());
    },
    { scope: 'worker' },
  ],

  db: [
    async ({}, use) => {
      const pool = createPool();
      await use(pool);
      await pool.end();
    },
    { scope: 'worker' },
  ],

  users: async ({ db, mailpit }, use) => {
    const created: TestUser[] = [];
    await use({
      next(label = 'Student') {
        const id = randomBytes(6).toString('hex');
        const user = {
          email: `${E2E_ADDRESS_PREFIX}${id}@example.test`,
          // Random and long: passes the password policy (≥ 10 chars, not a common password).
          password: `pw-${randomBytes(12).toString('base64url')}`,
          displayName: `E2E ${label} ${id}`,
        };
        created.push(user);
        return user;
      },
    });
    // Cleanup: the users (and everything that references them or they own) and their mail.
    const emails = created.map((u) => u.email);
    await deleteUsersAndMedia(db, await userIdsByEmail(db, emails));
    await mailpit.deleteFor(emails);
  },

  admin: async ({}, use) => {
    const { E2E_ADMIN_USER_ID, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_ADMIN_DISPLAY_NAME } =
      process.env;
    if (!E2E_ADMIN_USER_ID || !E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD) {
      throw new Error('The e2e admin is missing: src/global-setup.ts did not run');
    }
    await use({
      userId: E2E_ADMIN_USER_ID,
      email: E2E_ADMIN_EMAIL,
      password: E2E_ADMIN_PASSWORD,
      displayName: E2E_ADMIN_DISPLAY_NAME ?? 'E2E Admin',
    });
  },
});
