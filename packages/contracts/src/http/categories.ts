import { z } from 'zod';
import { CategoryNameSchema } from './catalog';
import { SlugSchema, UuidSchema } from './fields';

/**
 * Categories form a two-level tree (design §4): depth-1 groups with depth-2 leaves.
 * Courses reference an active depth-2 category.
 */
export const CATEGORY_MAX_DEPTH = 2;

/* ----------------------------------------------------------------------------------------
 * GET /catalog/categories -> 200 CategoryTreeResponse (public, active only, ordered)
 * -------------------------------------------------------------------------------------- */

export const CategoryLeafSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
});
export type CategoryLeaf = z.infer<typeof CategoryLeafSchema>;

export const CategoryNodeSchema = CategoryLeafSchema.extend({
  /** Depth-2 children, ordered by position. */
  children: z.array(CategoryLeafSchema),
});
export type CategoryNode = z.infer<typeof CategoryNodeSchema>;

export const CategoryTreeResponseSchema = z.object({ items: z.array(CategoryNodeSchema) });
export type CategoryTreeResponse = z.infer<typeof CategoryTreeResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * Admin: GET /admin/categories -> 200 AdminCategoryTreeResponse (including inactive)
 * -------------------------------------------------------------------------------------- */

export const CategorySchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  depth: z.union([z.literal(1), z.literal(2)]),
  slug: z.string(),
  name: z.string(),
  position: z.number().int().min(0),
  isActive: z.boolean(),
});
export type Category = z.infer<typeof CategorySchema>;

export const AdminCategoryLeafSchema = CategorySchema.extend({
  /** Courses (working copies, not deleted) assigned to this category. */
  courseCount: z.number().int().min(0),
});
export type AdminCategoryLeaf = z.infer<typeof AdminCategoryLeafSchema>;

export const AdminCategoryNodeSchema = AdminCategoryLeafSchema.extend({
  children: z.array(AdminCategoryLeafSchema),
});
export type AdminCategoryNode = z.infer<typeof AdminCategoryNodeSchema>;

export const AdminCategoryTreeResponseSchema = z.object({
  items: z.array(AdminCategoryNodeSchema),
});
export type AdminCategoryTreeResponse = z.infer<typeof AdminCategoryTreeResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /admin/categories -> 201 Category
 * -------------------------------------------------------------------------------------- */

/** No `parentId` creates a depth-1 group; a depth-1 parent creates a leaf. */
export const CreateCategoryRequestSchema = z.object({
  name: CategoryNameSchema,
  /** Generated from the name when omitted. */
  slug: SlugSchema.optional(),
  parentId: UuidSchema.optional(),
});
export type CreateCategoryRequest = z.output<typeof CreateCategoryRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * PATCH /admin/categories/:id -> 200 Category
 * -------------------------------------------------------------------------------------- */

/** Partial update; at least one field. `parentId` moves a leaf to another depth-1 group. */
export const UpdateCategoryRequestSchema = z
  .object({
    name: CategoryNameSchema.optional(),
    slug: SlugSchema.optional(),
    isActive: z.boolean().optional(),
    parentId: UuidSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of name, slug, isActive or parentId is required',
  })
  .meta({ minProperties: 1 });
export type UpdateCategoryRequest = z.output<typeof UpdateCategoryRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * PUT /admin/categories/order -> 204
 * DELETE /admin/categories/:id -> 204 (409 `category_in_use` when referenced)
 * -------------------------------------------------------------------------------------- */

/**
 * The full sibling order under one parent (`null` = the depth-1 groups). Must be an exact
 * permutation of the current children, otherwise 409 `order_mismatch`.
 */
export const ReorderCategoriesRequestSchema = z.object({
  parentId: UuidSchema.nullable(),
  orderedIds: z
    .array(UuidSchema)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' }),
});
export type ReorderCategoriesRequest = z.output<typeof ReorderCategoriesRequestSchema>;
