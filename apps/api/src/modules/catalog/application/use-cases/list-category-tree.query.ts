import { Injectable } from '@nestjs/common';
import type { CategoryTreeResponse } from '@udemy/contracts';
import { CategoryRepository } from '../ports/category.repository';
import { toPublicCategoryTree } from '../views';

/**
 * `ListCategoryTree` (design §5, public): active groups and their active leaves, ordered.
 * The public route `GET /catalog/categories` (with its Cache-Control) is wired by P2-T11.
 */
@Injectable()
export class ListCategoryTreeQuery {
  constructor(private readonly categories: CategoryRepository) {}

  async execute(): Promise<CategoryTreeResponse> {
    return { items: toPublicCategoryTree(await this.categories.listAll()) };
  }
}
