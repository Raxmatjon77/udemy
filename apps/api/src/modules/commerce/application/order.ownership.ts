import { z } from 'zod';
import { type OwnershipResolver, OwnershipResolverFor } from '../../../shared/auth';
import { OrderOwnerReader } from './ports/order-owner.reader';

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/**
 * Ownership of orders for `@CheckPolicy({ resource: 'order', action: 'read' | 'refund' })` with
 * `order:*:own` (design §3, §9 IDOR): the buyer, `orders.user_id`. A foreign or unknown order
 * answers 404 (never 403). Used by P4-T15/T16 (`GET /me/orders/:orderId`, receipt, cancel,
 * refunds); lines and refunds are always resolved WITHIN the order by those use cases.
 *
 * The guard runs before the param pipes, so a malformed id answers "does not exist" (404).
 */
@OwnershipResolverFor('order')
export class OrderOwnership implements OwnershipResolver {
  constructor(private readonly orders: OrderOwnerReader) {}

  async ownerOf(resourceId: string): Promise<string | null> {
    if (!isUuid(resourceId)) return null;
    return this.orders.ownerOf(resourceId);
  }
}
