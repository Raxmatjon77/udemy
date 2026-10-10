import type { DB, Executor, Transaction } from '@udemy/db';
import type { CategoryFacts } from '../../domain/category';

export interface CategoryRecord extends CategoryFacts {
  readonly slug: string;
  readonly name: string;
  readonly position: number;
}

export interface CategoryWithCount extends CategoryRecord {
  /** Non-deleted courses (working copies) assigned to this category. */
  readonly courseCount: number;
}

export interface NewCategory {
  readonly parentId: string | null;
  readonly depth: 1 | 2;
  readonly slug: string;
  readonly name: string;
  readonly position: number;
}

export interface CategoryPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly isActive?: boolean;
  /** Moving a leaf: the new parent and its position there. */
  readonly move?: { readonly parentId: string; readonly position: number };
}

/** The admin-managed two-level tree (`catalog.categories`). */
export abstract class CategoryRepository {
  /**
   * Tree-wide mutex for category WRITES (`pg_advisory_xact_lock`): admin edits are rare, and
   * one lock keeps sibling positions contiguous under concurrent create/move/reorder/delete.
   */
  abstract lockTree(trx: Transaction<DB>): Promise<void>;

  /**
   * The node and its parent `FOR SHARE` (schema doc §6 item 10: a concurrent deactivate waits,
   * so "assign/submit an active category" cannot race it). Lock order: after the course row.
   */
  abstract findForShare(trx: Transaction<DB>, id: string): Promise<CategoryFacts | null>;

  abstract findById(id: string, ex?: Executor): Promise<CategoryRecord | null>;

  /** The whole tree (inactive included), ordered by depth/parent/position, with counts. */
  abstract listAll(ex?: Executor): Promise<CategoryWithCount[]>;

  /** Ids of the children of `parentId` (null = roots), by position. */
  abstract listChildIds(trx: Transaction<DB>, parentId: string | null): Promise<string[]>;

  /** Category slugs starting with `prefix`. */
  abstract findSlugsWithPrefix(ex: Executor, prefix: string): Promise<Set<string>>;

  /** Children + course and revision references. */
  abstract countUsage(
    trx: Transaction<DB>,
    id: string,
  ): Promise<{ children: number; references: number }>;

  abstract insert(trx: Transaction<DB>, category: NewCategory): Promise<CategoryRecord>;

  abstract update(trx: Transaction<DB>, id: string, patch: CategoryPatch): Promise<CategoryRecord>;

  abstract setPositions(
    trx: Transaction<DB>,
    positions: readonly { readonly id: string; readonly position: number }[],
  ): Promise<void>;

  /** Closes gaps in the positions of `parentId`'s children (after a delete or move). */
  abstract compactPositions(trx: Transaction<DB>, parentId: string | null): Promise<void>;

  /** Hard delete; any FK reference (children, courses, revisions) is CategoryInUse. */
  abstract delete(trx: Transaction<DB>, id: string): Promise<void>;
}
