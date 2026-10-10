import type { Executor } from '@udemy/db';

/** `orders.user_id` (immutable, so read without a lock; `findOrderOwner`). */
export abstract class OrderOwnerReader {
  /** null = no such order. */
  abstract ownerOf(orderId: string, ex?: Executor): Promise<string | null>;
}
