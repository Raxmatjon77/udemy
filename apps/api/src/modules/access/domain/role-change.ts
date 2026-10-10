import { ErrorCode, type RoleGrantSource } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';

/** Mirrors `role_changes_reason_ck`. */
export const ROLE_CHANGE_REASON_MAX = 1000;

/** The reason is stored in the append-only history, so it must be meaningful. -> 422 */
export function assertRoleChangeReason(reason: string): void {
  if (reason.trim().length === 0 || reason.length > ROLE_CHANGE_REASON_MAX) {
    throw new ValidationError('The reason must be 1 to 1000 characters long.', {
      code: ErrorCode.ValidationFailed,
      issues: [{ path: 'reason', message: 'Must be 1 to 1000 characters long' }],
    });
  }
}

/**
 * `actorId` is null exactly for the CLI bootstrap of the first admin (mirrors
 * `role_changes_actor_id_ck` and the RoleGranted contract). A mismatch is a bug in the
 * calling code, not bad input, so it is a plain Error (-> 500).
 */
export function assertGrantProvenance(actorId: string | null, source: RoleGrantSource): void {
  if ((actorId === null) !== (source.type === 'cli_bootstrap')) {
    throw new Error(
      `grantRole: actorId must be null exactly when source.type is cli_bootstrap (got source ${source.type})`,
    );
  }
}
