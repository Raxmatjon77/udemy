import { ErrorCode } from '@udemy/contracts';
import { NotFoundError, ValidationError } from '@udemy/nest-common/errors';

/** Only INSTRUCTOR and ADMIN can be granted or revoked; STUDENT is implicit (D5). -> 422 */
export class RoleNotAssignable extends ValidationError {
  constructor(
    readonly role: string,
    options: { cause?: unknown } = {},
  ) {
    super(`The role ${role} cannot be granted or revoked.`, {
      code: ErrorCode.RoleNotAssignable,
      cause: options.cause,
    });
  }
}

/** The target account does not exist. -> 404 */
export class UserNotFound extends NotFoundError {
  constructor(options: { cause?: unknown } = {}) {
    super('The user does not exist.', { code: ErrorCode.UserNotFound, cause: options.cause });
  }
}
