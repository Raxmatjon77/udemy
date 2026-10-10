import { ConflictException } from '@nestjs/common';
import { ErrorCode } from '@udemy/contracts';
import { UploadIncomplete } from '../domain/media.errors';

/** Absolute path of an upload (the `Location` of a 201), as the BFFs see it. */
export function uploadLocation(assetId: string): string {
  return `/api/v1/media/uploads/${assetId}`;
}

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
