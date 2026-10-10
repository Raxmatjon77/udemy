import { Injectable } from '@nestjs/common';
import { CategoryNotFound } from '../../domain/catalog.errors';
import { planSiblingOrder } from '../../domain/curriculum';
import { CategoryRepository } from '../ports/category.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface ReorderCategoriesInput {
  /** null = the depth-1 groups. */
  readonly parentId: string | null;
  readonly orderedIds: readonly string[];
}

/**
 * `ReorderCategories` (design §5, admin): the full sibling order under one parent; it must be
 * exactly a permutation of the current children (409 `order_mismatch`). Positions are
 * rewritten in one transaction (deferred unique).
 */
@Injectable()
export class ReorderCategoriesCommand {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: ReorderCategoriesInput): Promise<void> {
    await this.tx.run(async (trx) => {
      await this.categories.lockTree(trx);
      if (
        input.parentId !== null &&
        (await this.categories.findById(input.parentId, trx)) === null
      ) {
        throw new CategoryNotFound();
      }
      const current = await this.categories.listChildIds(trx, input.parentId);
      await this.categories.setPositions(trx, planSiblingOrder(current, input.orderedIds));
    });
  }
}
