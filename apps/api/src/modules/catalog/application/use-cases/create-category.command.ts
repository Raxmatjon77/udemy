import { Injectable } from '@nestjs/common';
import type { Category } from '@udemy/contracts';
import { childDepth } from '../../domain/category';
import { firstFreeSlug, slugBase, slugCandidatePrefix } from '../../domain/slug';
import { CategoryRepository } from '../ports/category.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toCategoryView } from '../views';

export interface CreateCategoryInput {
  readonly name: string;
  /** Explicit slug (409 `slug_taken` when used); generated from the name when omitted. */
  readonly slug?: string;
  /** A depth-1 group to create a leaf under; omitted creates a group. */
  readonly parentId?: string;
}

/**
 * `CreateCategory` (design §5, admin): appended at the end of its siblings, under the
 * category-tree lock. A parent must exist (404 `category_not_found`) and be a group (422
 * `category_depth_exceeded`).
 */
@Injectable()
export class CreateCategoryCommand {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: CreateCategoryInput): Promise<Category> {
    return this.tx.run(async (trx) => {
      await this.categories.lockTree(trx);
      const parent =
        input.parentId === undefined
          ? undefined
          : await this.categories.findById(input.parentId, trx);
      const depth = childDepth(parent);
      const parentId = input.parentId ?? null;

      let slug = input.slug;
      if (slug === undefined) {
        const base = slugBase(input.name, 'category');
        slug = firstFreeSlug(
          base,
          await this.categories.findSlugsWithPrefix(trx, slugCandidatePrefix(base)),
        );
      }
      const siblings = await this.categories.listChildIds(trx, parentId);
      const created = await this.categories.insert(trx, {
        parentId,
        depth,
        slug,
        name: input.name,
        position: siblings.length,
      });
      return toCategoryView(created);
    });
  }
}
