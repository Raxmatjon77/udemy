import {
  createCommerceHandlers,
  createCommerceMockStore,
  defaultMockUsers,
  type CommerceMockSeed,
  type CommerceMockStore,
  type MockCourse,
} from '@udemy/contracts/testing';

import { IDS } from './fixtures';
import { server } from './msw';

/**
 * The `@udemy/contracts/testing` commerce mock (pricing, coupons, sales) behind `/api/proxy/*`,
 * with the signed-in instructor (`IDS.owner`) as the viewer and the builder's course
 * (`IDS.course`) in the store. Every response is parsed with its contracts schema first.
 *
 * Not modelled by the store: 429s and pagination (`nextCursor` is always null); specs override
 * single routes with `server.use(...)` for those.
 */

export const PROXY_BASE = '*/api/proxy';

export function builderCourse(overrides: Partial<MockCourse> = {}): MockCourse {
  return {
    id: IDS.course,
    slug: 'nestjs-in-practice',
    title: 'NestJS in practice',
    ownerId: IDS.owner,
    status: 'DRAFT',
    price: '19.99',
    ...overrides,
  };
}

export function installCommerce(
  seed: Omit<CommerceMockSeed, 'viewerId'> & { course?: Partial<MockCourse> } = {},
): CommerceMockStore {
  const { course, ...rest } = seed;
  const store = createCommerceMockStore({
    viewerId: IDS.owner,
    users: [
      ...defaultMockUsers(),
      { id: IDS.owner, displayName: 'Jane Instructor', email: 'jane@example.com' },
    ],
    courses: [builderCourse(course)],
    ...rest,
  });
  server.use(...createCommerceHandlers({ baseUrl: PROXY_BASE, store }).handlers);
  return store;
}
