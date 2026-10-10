import { UuidSchema } from '@udemy/contracts';

/**
 * The order id of `/checkout/success` and `/checkout/cancel`. The API's success and cancel URLs
 * use `?orderId=` (design §10); `?order=` is accepted too. Anything that is not a UUID is
 * ignored, so nothing odd ever reaches an API path.
 */
export function orderIdFromSearch(
  search: Record<string, string | string[] | undefined>,
): string | null {
  for (const name of ['orderId', 'order']) {
    const raw = search[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = UuidSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}
