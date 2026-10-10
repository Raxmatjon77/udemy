import { Injectable } from '@nestjs/common';
import type { CouponState } from '@udemy/contracts';
import { type DB, type Executor, lockUserCart, quoteCart, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { CartRepository, type CartQuoteRecord } from '../application/ports/cart.repository';
import { mapCommerceConstraints } from './commerce-constraint-errors';

@Injectable()
export class KyselyCartRepository extends CartRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  lockCart(trx: Transaction<DB>, userId: string): Promise<{ couponCode: string | null }> {
    return lockUserCart(trx, userId);
  }

  async findCouponCode(userId: string, ex: Executor = this.db): Promise<string | null> {
    const row = await ex
      .selectFrom('commerce.carts')
      .select('couponCode')
      .where('userId', '=', userId)
      .executeTakeFirst();
    return row?.couponCode ?? null;
  }

  async quote(userId: string, ex: Executor): Promise<CartQuoteRecord> {
    const { lines, candidates } = await quoteCart(ex, userId);
    return {
      lines: lines.map((l) => ({
        courseId: l.courseId,
        addedAt: l.addedAt,
        listAmount: l.listAmount,
        currency: l.currency,
        couponId: l.couponId,
        discountAmount: l.discountAmount,
      })),
      candidates: candidates.map((c) => ({
        id: c.id,
        scope: c.scope,
        courseId: c.courseId,
        discountType: c.discountType,
        percentOff: c.percentOff,
        amountOff: c.amountOff,
        currency: c.currency,
        state: c.state satisfies CouponState,
        usedByMe: c.usedByMe,
      })),
    };
  }

  async listCourseIds(userId: string, ex: Executor = this.db): Promise<string[]> {
    const rows = await ex
      .selectFrom('commerce.cartItems')
      .select('courseId')
      .where('userId', '=', userId)
      .orderBy('addedAt')
      .orderBy('courseId')
      .execute();
    return rows.map((r) => r.courseId);
  }

  addItem(trx: Transaction<DB>, userId: string, courseId: string): Promise<boolean> {
    return mapCommerceConstraints(async () => {
      const inserted = await trx
        .insertInto('commerce.cartItems')
        .values({ userId, courseId })
        .onConflict((oc) => oc.columns(['userId', 'courseId']).doNothing())
        .returning('courseId')
        .executeTakeFirst();
      return inserted !== undefined;
    });
  }

  async removeItem(userId: string, courseId: string, ex: Executor = this.db): Promise<void> {
    await ex
      .deleteFrom('commerce.cartItems')
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .execute();
  }

  setCouponCode(trx: Transaction<DB>, userId: string, code: string | null): Promise<void> {
    return mapCommerceConstraints(async () => {
      await trx
        .updateTable('commerce.carts')
        .set({ couponCode: code })
        .where('userId', '=', userId)
        .execute();
    });
  }

  async findInCart(
    userId: string,
    courseIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<ReadonlySet<string>> {
    if (courseIds.length === 0) return new Set();
    const rows = await ex
      .selectFrom('commerce.cartItems')
      .select('courseId')
      .where('userId', '=', userId)
      .where('courseId', 'in', [...courseIds])
      .execute();
    return new Set(rows.map((r) => r.courseId));
  }
}
