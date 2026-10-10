import type { CategoryLeaf, CategoryNode } from '@udemy/contracts';

/** A category found in the two-level tree: a depth-1 group, or a leaf with its group. */
export type CategoryMatch =
  | { kind: 'group'; group: CategoryNode; leaf: null }
  | { kind: 'leaf'; group: CategoryNode; leaf: CategoryLeaf };

/** Finds a category (group or leaf) by slug. */
export function findCategory(tree: readonly CategoryNode[], slug: string): CategoryMatch | null {
  for (const group of tree) {
    if (group.slug === slug) return { kind: 'group', group, leaf: null };
    const leaf = group.children.find((child) => child.slug === slug);
    if (leaf) return { kind: 'leaf', group, leaf };
  }
  return null;
}

export function categoryHref(slug: string): string {
  return `/categories/${encodeURIComponent(slug)}`;
}
