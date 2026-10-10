import { Injectable } from '@nestjs/common';
import type { Category } from '@udemy/contracts';
import { assertCanMove } from '../../domain/category';
import { CategoryNotFound } from '../../domain/catalog.errors';
import { type CategoryPatch, CategoryRepository } from '../ports/category.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toCategoryView } from '../views';

export interface UpdateCategoryInput {
  readonly id: string;
  readonly name?: string;
  readonly slug?: string;
  readonly isActive?: boolean;
  /** Moves a leaf to another group (appended there; the old group's positions are compacted). */
  readonly parentId?: string;
}

/**
 * `UpdateCategory` (design §5, admin): rename, re-slug (409 `slug_taken`), (de)activate, or
 * move a leaf to another group (422 `category_depth_exceeded` for groups or a leaf target).
 * Deactivating hides the category from browse and blocks new assignments; courses that use it
 * keep it.
 */
@Injectable()
export class UpdateCategoryCommand {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: UpdateCategoryInput): Promise<Category> {
    return this.tx.run(async (trx) => {
      await this.categories.lockTree(trx);
      const node = await this.categories.findById(input.id, trx);
      if (node === null) throw new CategoryNotFound();

      const patch: { -readonly [K in keyof CategoryPatch]: CategoryPatch[K] } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.slug !== undefined && input.slug !== node.slug) patch.slug = input.slug;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      const moving = input.parentId !== undefined && input.parentId !== node.parentId;
      if (moving && input.parentId !== undefined) {
        assertCanMove(node, await this.categories.findById(input.parentId, trx));
        const siblings = await this.categories.listChildIds(trx, input.parentId);
        patch.move = { parentId: input.parentId, position: siblings.length };
      }

      const updated = await this.categories.update(trx, node.id, patch);
      if (moving) await this.categories.compactPositions(trx, node.parentId);
      return toCategoryView(updated);
    });
  }
}
