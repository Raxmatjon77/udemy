import { Injectable } from '@nestjs/common';
import { type DB, type Executor, escapeLikePattern, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type CategoryPatch,
  type CategoryRecord,
  CategoryRepository,
  type CategoryWithCount,
  type NewCategory,
} from '../application/ports/category.repository';
import type { CategoryFacts } from '../domain/category';
import { CategoryInUse } from '../domain/catalog.errors';
import { isForeignKeyViolation, mapCatalogConstraints } from './catalog-constraint-errors';

/**
 * Advisory-lock class of the category-tree mutex (`'catg'`), in the two-int key space like
 * media's quota lock; the second key is `hashtext('catalog:categories')`.
 */
export const CATEGORY_TREE_LOCK_CLASS = 0x63617467;

function toDepth(value: number): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new Error(`Unexpected catalog.categories.depth ${value}`);
}

export interface CategoryRow {
  id: string;
  parentId: string | null;
  depth: number;
  slug: string;
  name: string;
  position: number;
  isActive: boolean;
  parentActive: boolean | null;
}

export function toRecord(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    depth: toDepth(row.depth),
    slug: row.slug,
    name: row.name,
    position: row.position,
    isActive: row.isActive,
    parentActive: row.parentActive ?? true,
  };
}

/** `catalog.categories` with Kysely (a tiny table: full scans are fine). */
@Injectable()
export class KyselyCategoryRepository extends CategoryRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async lockTree(trx: Transaction<DB>): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(${CATEGORY_TREE_LOCK_CLASS}::int, hashtext('catalog:categories'))`.execute(
      trx,
    );
  }

  async findForShare(trx: Transaction<DB>, id: string): Promise<CategoryFacts | null> {
    const { rows } = await sql<{
      id: string;
      parentId: string | null;
      depth: number;
      isActive: boolean;
    }>`
      SELECT id, parent_id, depth, is_active FROM catalog.categories
       WHERE id = ${id} OR id = (SELECT parent_id FROM catalog.categories WHERE id = ${id})
       ORDER BY depth
         FOR SHARE
    `.execute(trx);
    const node = rows.find((r) => r.id === id);
    if (node === undefined) return null;
    const parent = rows.find((r) => r.id === node.parentId);
    return {
      id: node.id,
      parentId: node.parentId,
      depth: toDepth(node.depth),
      isActive: node.isActive,
      parentActive: parent?.isActive ?? true,
    };
  }

  async findById(id: string, ex: Executor = this.db): Promise<CategoryRecord | null> {
    const row = await this.select(ex).where('c.id', '=', id).executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async listAll(ex: Executor = this.db): Promise<CategoryWithCount[]> {
    const rows = await this.select(ex)
      .select((eb) =>
        eb
          .selectFrom('catalog.courses as k')
          .select((k) => k.fn.countAll<string>().as('n'))
          .whereRef('k.categoryId', '=', 'c.id')
          .where('k.deletedAt', 'is', null)
          .as('courseCount'),
      )
      .orderBy('c.depth')
      .orderBy('c.position')
      .execute();
    return rows.map((row) => ({ ...toRecord(row), courseCount: Number(row.courseCount ?? 0) }));
  }

  async listChildIds(trx: Transaction<DB>, parentId: string | null): Promise<string[]> {
    let query = trx.selectFrom('catalog.categories').select('id');
    query =
      parentId === null
        ? query.where('parentId', 'is', null)
        : query.where('parentId', '=', parentId);
    const rows = await query.orderBy('position').execute();
    return rows.map((r) => r.id);
  }

  async findSlugsWithPrefix(ex: Executor, prefix: string): Promise<Set<string>> {
    const rows = await ex
      .selectFrom('catalog.categories')
      .select('slug')
      .where('slug', 'like', `${escapeLikePattern(prefix)}%`)
      .execute();
    return new Set(rows.map((r) => r.slug));
  }

  async countUsage(
    trx: Transaction<DB>,
    id: string,
  ): Promise<{ children: number; references: number }> {
    const { rows } = await sql<{ children: number; refs: number }>`
      SELECT (SELECT count(*) FROM catalog.categories WHERE parent_id = ${id})::int AS children,
             ((SELECT count(*) FROM catalog.courses WHERE category_id = ${id})
              + (SELECT count(*) FROM catalog.course_revisions WHERE category_id = ${id}))::int AS refs
    `.execute(trx);
    const row = rows[0];
    return { children: row?.children ?? 0, references: row?.refs ?? 0 };
  }

  async insert(trx: Transaction<DB>, category: NewCategory): Promise<CategoryRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.categories')
        .values(category)
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return this.reload(trx, row.id);
  }

  async update(trx: Transaction<DB>, id: string, patch: CategoryPatch): Promise<CategoryRecord> {
    await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.categories')
        .set({
          name: patch.name,
          slug: patch.slug,
          isActive: patch.isActive,
          parentId: patch.move?.parentId,
          position: patch.move?.position,
          updatedAt: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    return this.reload(trx, id);
  }

  async setPositions(
    trx: Transaction<DB>,
    positions: readonly { readonly id: string; readonly position: number }[],
  ): Promise<void> {
    if (positions.length === 0) return;
    await mapCatalogConstraints(() =>
      sql`
        UPDATE catalog.categories c SET position = v.position
          FROM unnest(${positions.map((p) => p.id)}::uuid[],
                      ${positions.map((p) => p.position)}::int[]) AS v(id, position)
         WHERE c.id = v.id AND c.position <> v.position
      `.execute(trx),
    );
  }

  async compactPositions(trx: Transaction<DB>, parentId: string | null): Promise<void> {
    await mapCatalogConstraints(() =>
      sql`
        UPDATE catalog.categories c SET position = r.rn - 1
          FROM (SELECT id, (row_number() OVER (ORDER BY position))::int AS rn
                  FROM catalog.categories WHERE parent_id IS NOT DISTINCT FROM ${parentId}::uuid) r
         WHERE c.id = r.id AND c.position <> r.rn - 1
      `.execute(trx),
    );
  }

  async delete(trx: Transaction<DB>, id: string): Promise<void> {
    try {
      await trx.deleteFrom('catalog.categories').where('id', '=', id).execute();
    } catch (error) {
      // Children, courses (deleted ones too) or revisions still reference it (all RESTRICT).
      if (isForeignKeyViolation(error)) throw new CategoryInUse({ cause: error });
      throw error;
    }
  }

  private async reload(ex: Executor, id: string): Promise<CategoryRecord> {
    const row = await this.select(ex).where('c.id', '=', id).executeTakeFirstOrThrow();
    return toRecord(row);
  }

  private select(ex: Executor) {
    return ex
      .selectFrom('catalog.categories as c')
      .leftJoin('catalog.categories as p', 'p.id', 'c.parentId')
      .select([
        'c.id',
        'c.parentId',
        'c.depth',
        'c.slug',
        'c.name',
        'c.position',
        'c.isActive',
        'p.isActive as parentActive',
      ]);
  }
}
