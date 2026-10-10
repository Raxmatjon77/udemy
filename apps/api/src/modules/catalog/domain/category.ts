import {
  CategoryDepthExceeded,
  CategoryInactive,
  CategoryInUse,
  CategoryNotFound,
  CategoryNotLeaf,
} from './catalog.errors';

/** The facts category rules depend on (a node and, for leaves, its group). */
export interface CategoryFacts {
  readonly id: string;
  readonly depth: 1 | 2;
  readonly parentId: string | null;
  readonly isActive: boolean;
  /** For depth-2 nodes: whether the parent group is active (true for roots). */
  readonly parentActive: boolean;
}

/**
 * A course may be assigned only an active depth-2 category whose group is active too
 * (deactivating a group hides its leaves from browse, design §4).
 *
 * @throws CategoryNotFound (404), CategoryNotLeaf (422), CategoryInactive (422)
 */
export function assertAssignable(
  category: CategoryFacts | null,
): asserts category is CategoryFacts {
  if (category === null) throw new CategoryNotFound();
  if (category.depth !== 2) throw new CategoryNotLeaf();
  if (!isEffectivelyActive(category)) throw new CategoryInactive();
}

export function isEffectivelyActive(
  category: Pick<CategoryFacts, 'isActive' | 'parentActive'>,
): boolean {
  return category.isActive && category.parentActive;
}

/**
 * Depth of a new node under `parent` (two-level tree).
 *
 * @throws CategoryNotFound when the parent does not exist, CategoryDepthExceeded below a leaf
 */
export function childDepth(parent: CategoryFacts | null | undefined): 1 | 2 {
  if (parent === undefined) return 1;
  if (parent === null) throw new CategoryNotFound();
  if (parent.depth !== 1) throw new CategoryDepthExceeded();
  return 2;
}

/**
 * Moving a node to another parent: only leaves move, and only below a group.
 *
 * @throws CategoryDepthExceeded, CategoryNotFound
 */
export function assertCanMove(node: CategoryFacts, newParent: CategoryFacts | null): void {
  if (node.depth !== 2) throw new CategoryDepthExceeded();
  if (newParent === null) throw new CategoryNotFound();
  if (newParent.depth !== 1) throw new CategoryDepthExceeded();
}

/** @throws CategoryInUse (409) while the node has children or is referenced */
export function assertDeletable(usage: {
  readonly children: number;
  readonly references: number;
}): void {
  if (usage.children > 0 || usage.references > 0) throw new CategoryInUse();
}
