import type { CategoryLeaf } from '@udemy/contracts';
import { isEffectivelyActive } from '../domain/category';
import type { CategoryRecord } from './ports/category.repository';

/**
 * Shared helpers of the public read side (browse, landing): category lookups on the small,
 * fully loaded tree, and which thumbnails can actually be served.
 */

const toLeaf = (category: CategoryRecord): CategoryLeaf => ({
  id: category.id,
  slug: category.slug,
  name: category.name,
});

/**
 * The depth-2 category ids a browse `?category=` slug selects: the leaf itself, or every
 * active leaf of a group (design §5: a depth-1 slug includes its children). A deactivated or
 * unknown slug selects nothing ("hidden from browse", design §4).
 */
export function browseCategoryIds(
  categories: readonly CategoryRecord[],
  slug: string,
): readonly string[] {
  const node = categories.find((c) => c.slug === slug);
  if (node === undefined || !isEffectivelyActive(node)) return [];
  if (node.depth === 2) return [node.id];
  return categories
    .filter((c) => c.parentId === node.id && isEffectivelyActive(c))
    .map((c) => c.id);
}

/**
 * The live revision's category as shown publicly. A live revision keeps its category even
 * after a moderator deactivates it (design §4), so inactive categories are still named.
 */
export class CategoryDirectory {
  private readonly byId: ReadonlyMap<string, CategoryRecord>;

  constructor(categories: readonly CategoryRecord[]) {
    this.byId = new Map(categories.map((c) => [c.id, c]));
  }

  leaf(id: string | null): CategoryLeaf | null {
    const category = id === null ? undefined : this.byId.get(id);
    return category === undefined ? null : toLeaf(category);
  }

  /** `[group, leaf]` (root first); shorter when a node is missing. */
  path(id: string | null): CategoryLeaf[] {
    const leaf = id === null ? undefined : this.byId.get(id);
    if (leaf === undefined) return [];
    const parent = leaf.parentId === null ? undefined : this.byId.get(leaf.parentId);
    return parent === undefined ? [toLeaf(leaf)] : [toLeaf(parent), toLeaf(leaf)];
  }
}

/** A thumbnail asset that `MediaFacade.presignImage(id, 'w750')` will sign. */
export function isServableThumbnail(asset: {
  readonly status: string;
  readonly purged: boolean;
  readonly renditions: readonly string[];
}): boolean {
  return asset.status === 'READY' && !asset.purged && asset.renditions.includes('w750');
}
