import { ConflictException } from '@nestjs/common';
import {
  AssetViewSchema,
  emptyToUndefined,
  ErrorCode,
  MEDIA_UPLOAD_LIMITS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  pageSchema,
  paginationQuerySchema,
  UuidSchema,
} from '@udemy/contracts';
import { z } from 'zod';
import { UploadIncomplete } from '../domain/media.errors';

/** Absolute path of an upload (the `Location` of a 201), as the BFFs see it. */
export function uploadLocation(assetId: string): string {
  return `/api/v1/media/uploads/${assetId}`;
}

/** `?ids=a,b,c` or repeated `?ids=a&ids=b` (same rules as the contracts' `AssetsQuerySchema`). */
function splitCommaList(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string') return value.split(',');
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => (typeof item === 'string' ? item.split(',') : [item]));
  }
  return value;
}

/**
 * `GET /media/assets` query: either `ids` (design §8, contracts `AssetsQuerySchema`) or a
 * keyset page (`cursor`, `limit`; admins may add `ownerId`). Both modes answer
 * `{ items, nextCursor }`; with `ids`, `nextCursor` is always null.
 */
export const MediaAssetListQuerySchema = paginationQuerySchema(PAGE_LIMIT_MAX, PAGE_LIMIT_DEFAULT)
  .extend({
    ids: z.preprocess(
      splitCommaList,
      z
        .array(UuidSchema)
        .min(1)
        .max(MEDIA_UPLOAD_LIMITS.maxAssetIdsPerQuery)
        .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' })
        .optional(),
    ),
    ownerId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
  })
  .refine((q) => q.ids === undefined || q.cursor === undefined, {
    message: 'Use either ids or cursor',
    path: ['cursor'],
  });
export type MediaAssetListQuery = z.output<typeof MediaAssetListQuerySchema>;

export const AssetPageSchema = pageSchema(AssetViewSchema);

/**
 * Runs a use case and turns `UploadIncomplete` into the contract's
 * `UploadIncompleteProblem` (409 + `missingParts`): the global filter keeps the extra members
 * of an HttpException body as RFC 7807 extension members.
 */
export async function withUploadProblems<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UploadIncomplete) {
      throw new ConflictException(
        {
          message: error.message,
          code: ErrorCode.UploadIncomplete,
          missingParts: [...error.missingParts],
        },
        { cause: error },
      );
    }
    throw error;
  }
}
