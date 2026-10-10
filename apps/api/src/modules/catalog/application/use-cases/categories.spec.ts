import { beforeEach, describe, expect, it } from 'vitest';
import {
  CategoryDepthExceeded,
  CategoryInUse,
  CategoryNotFound,
  OrderMismatch,
  SlugTaken,
} from '../../domain/catalog.errors';
import { testId } from '../testing/catalog.fakes';
import { type CatalogHarness, createCatalogHarness } from '../testing/catalog.harness';

describe('categories (admin use cases with fakes)', () => {
  let h: CatalogHarness;
  beforeEach(() => {
    h = createCatalogHarness();
  });

  it('builds a two-level tree with generated slugs and appended positions', async () => {
    const dev = await h.createCategory.execute({ name: 'Development' });
    const design = await h.createCategory.execute({ name: 'Design', slug: 'design-all' });
    const web = await h.createCategory.execute({ name: 'Web Development', parentId: dev.id });
    const web2 = await h.createCategory.execute({ name: 'Web development', parentId: dev.id });
    expect([dev, design, web, web2].map((c) => [c.slug, c.depth, c.position])).toEqual([
      ['development', 1, 0],
      ['design-all', 1, 1],
      ['web-development', 2, 0],
      ['web-development-2', 2, 1],
    ]);
    expect(h.categories.treeLocks).toBe(4);

    await expect(
      h.createCategory.execute({ name: 'Too deep', parentId: web.id }),
    ).rejects.toBeInstanceOf(CategoryDepthExceeded);
    await expect(
      h.createCategory.execute({ name: 'Orphan', parentId: testId() }),
    ).rejects.toBeInstanceOf(CategoryNotFound);
    await expect(
      h.createCategory.execute({ name: 'Dup', slug: 'design-all' }),
    ).rejects.toBeInstanceOf(SlugTaken);
  });

  it('admin tree includes inactive nodes and counts; public tree only active ones', async () => {
    const dev = await h.createCategory.execute({ name: 'Development' });
    const web = await h.createCategory.execute({ name: 'Web', parentId: dev.id });
    const mobile = await h.createCategory.execute({ name: 'Mobile', parentId: dev.id });
    const art = await h.createCategory.execute({ name: 'Art' });
    await h.createCategory.execute({ name: 'Drawing', parentId: art.id });
    await h.createCourse.execute({
      ownerId: '00000000-0000-7000-8000-0000000000a1',
      title: 'Counted course',
      categoryId: web.id,
    });
    await h.updateCategory.execute({ id: mobile.id, isActive: false });
    await h.updateCategory.execute({ id: art.id, isActive: false });

    const admin = await h.adminListCategories.execute();
    expect(
      admin.items.map((n) => [n.name, n.isActive, n.children.map((c) => [c.name, c.courseCount])]),
    ).toEqual([
      [
        'Development',
        true,
        [
          ['Web', 1],
          ['Mobile', 0],
        ],
      ],
      ['Art', false, [['Drawing', 0]]],
    ]);
    const tree = await h.listCategoryTree.execute();
    expect(tree.items.map((n) => [n.name, n.children.map((c) => c.name)])).toEqual([
      ['Development', ['Web']],
    ]);
  });

  it('moves a leaf to another group, compacting the old one; groups cannot move', async () => {
    const a = await h.createCategory.execute({ name: 'Group A' });
    const b = await h.createCategory.execute({ name: 'Group B' });
    const a1 = await h.createCategory.execute({ name: 'A one', parentId: a.id });
    const a2 = await h.createCategory.execute({ name: 'A two', parentId: a.id });
    const moved = await h.updateCategory.execute({ id: a1.id, parentId: b.id, name: 'Now B one' });
    expect(moved).toMatchObject({ parentId: b.id, position: 0, name: 'Now B one' });
    expect((await h.categories.findById(a2.id))?.position).toBe(0);
    await expect(h.updateCategory.execute({ id: a.id, parentId: b.id })).rejects.toBeInstanceOf(
      CategoryDepthExceeded,
    );
    await expect(h.updateCategory.execute({ id: a2.id, parentId: a1.id })).rejects.toBeInstanceOf(
      CategoryDepthExceeded,
    );
  });

  it('reorders siblings as an exact permutation', async () => {
    const x = await h.createCategory.execute({ name: 'Group X' });
    const y = await h.createCategory.execute({ name: 'Group Y' });
    await h.reorderCategories.execute({ parentId: null, orderedIds: [y.id, x.id] });
    expect((await h.adminListCategories.execute()).items.map((n) => n.name)).toEqual([
      'Group Y',
      'Group X',
    ]);
    await expect(
      h.reorderCategories.execute({ parentId: null, orderedIds: [x.id] }),
    ).rejects.toBeInstanceOf(OrderMismatch);
    await expect(
      h.reorderCategories.execute({ parentId: testId(), orderedIds: [x.id] }),
    ).rejects.toBeInstanceOf(CategoryNotFound);
  });

  it('deletes only unused categories (children or courses -> category_in_use)', async () => {
    const group = await h.createCategory.execute({ name: 'Group' });
    const leaf = await h.createCategory.execute({ name: 'Leaf', parentId: group.id });
    const spare = await h.createCategory.execute({ name: 'Spare', parentId: group.id });
    await h.createCourse.execute({
      ownerId: '00000000-0000-7000-8000-0000000000a1',
      title: 'Uses the leaf',
      categoryId: leaf.id,
    });
    await expect(h.deleteCategory.execute(group.id)).rejects.toBeInstanceOf(CategoryInUse);
    await expect(h.deleteCategory.execute(leaf.id)).rejects.toBeInstanceOf(CategoryInUse);
    await h.deleteCategory.execute(leaf.id === spare.id ? '' : spare.id);
    expect(await h.categories.findById(spare.id)).toBeNull();
    await expect(h.deleteCategory.execute(spare.id)).rejects.toBeInstanceOf(CategoryNotFound);
  });
});
