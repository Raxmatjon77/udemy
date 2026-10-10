import { Injectable } from '@nestjs/common';
import { assertDeletable } from '../../domain/category';
import { CategoryNotFound } from '../../domain/catalog.errors';
import { CategoryRepository } from '../ports/category.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/**
 * `DeleteCategory` (design §5, D13, admin): hard delete only when unused: no children and no
 * reference from any course (deleted ones included, their FK still points at it) or revision;
 * otherwise 409 `category_in_use` (deactivate instead). Sibling positions are compacted.
 */
@Injectable()
export class DeleteCategoryCommand {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(id: string): Promise<void> {
    await this.tx.run(async (trx) => {
      await this.categories.lockTree(trx);
      const node = await this.categories.findById(id, trx);
      if (node === null) throw new CategoryNotFound();
      assertDeletable(await this.categories.countUsage(trx, node.id));
      await this.categories.delete(trx, node.id);
      await this.categories.compactPositions(trx, node.parentId);
    });
  }
}
