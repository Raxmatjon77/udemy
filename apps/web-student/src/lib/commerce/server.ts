import 'server-only';
import {
  PUBLIC_PRICES_MAX_IDS,
  PublicPricesResponseSchema,
  type CourseCardPage,
  type PublicPrice,
} from '@udemy/contracts';

import { toPriceMap, type PriceMap } from '@/components/commerce/price-tag';

import { getJson, settle, type Loaded } from '../catalog/server';

/**
 * Server-side reads of the public prices (design §8 Public, §10 "Course cards and browse"):
 * anonymous, like the catalog, so a cached page never carries one user's view.
 */

/** `GET /commerce/prices?courseIds=` in batches of `PUBLIC_PRICES_MAX_IDS`. */
export async function getPublicPrices(courseIds: readonly string[]): Promise<PublicPrice[]> {
  const unique = [...new Set(courseIds)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += PUBLIC_PRICES_MAX_IDS) {
    batches.push(unique.slice(i, i + PUBLIC_PRICES_MAX_IDS));
  }
  const responses = await Promise.all(
    batches.map((ids) =>
      getJson(
        `/commerce/prices?${new URLSearchParams({ courseIds: ids.join(',') }).toString()}`,
        PublicPricesResponseSchema,
      ),
    ),
  );
  return responses.flatMap((response) => response.items);
}

/**
 * The prices of a loaded course page, or undefined when there is no page or the prices could
 * not be loaded (the cards then show no price line rather than a wrong "Not available").
 */
export async function pricesForPage(page: Loaded<CourseCardPage>): Promise<PriceMap | undefined> {
  if (!page.ok) return undefined;
  if (page.data.items.length === 0) return {};
  const prices = await settle(getPublicPrices(page.data.items.map((course) => course.id)));
  return prices.ok ? toPriceMap(prices.data) : undefined;
}

/** One course's price: the price, null when it has none (not for sale), undefined on failure. */
export async function priceForCourse(courseId: string): Promise<PublicPrice | null | undefined> {
  const prices = await settle(getPublicPrices([courseId]));
  if (!prices.ok) return undefined;
  return prices.data.find((price) => price.courseId === courseId) ?? null;
}
