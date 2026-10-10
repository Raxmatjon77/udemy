import { Injectable } from '@nestjs/common';
import type { AdminCategoryTreeResponse } from '@udemy/contracts';
import { CategoryRepository } from '../ports/category.repository';
import { toAdminCategoryTree } from '../views';

/** `AdminListCategories` (design §5): the full tree, inactive included, with course counts. */
@Injectable()
export class AdminListCategoriesQuery {
  constructor(private readonly categories: CategoryRepository) {}

  async execute(): Promise<AdminCategoryTreeResponse> {
    return { items: toAdminCategoryTree(await this.categories.listAll()) };
  }
}
