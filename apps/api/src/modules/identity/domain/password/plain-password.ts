import type { Email } from '../email';
import { WeakPassword } from '../identity.errors';
import { isCommonPassword } from './common-passwords';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordPolicyContext {
  /** The account's email: the password may equal neither it nor its local part. */
  email: Email;
  /** Request field the password came from, for the problem `errors[].path`. */
  field?: string;
}

/**
 * A new password that satisfies the policy of design §4 (NIST 800-63B): 10–128 characters
 * (code points), not the email or its local part, not in the bundled top-10k list.
 * No composition rules. The value is never trimmed or otherwise altered.
 *
 * Only new passwords (signup, reset, change) go through this VO. Login compares against the
 * stored hash and never re-applies the policy, so tightening it locks nobody out.
 */
export class PlainPassword {
  private constructor(readonly value: string) {}

  /** @throws WeakPassword (422 `weak_password`) */
  static create(raw: string, context: PasswordPolicyContext): PlainPassword {
    const { email, field } = context;
    const length = [...raw].length;
    if (length < PASSWORD_MIN_LENGTH) throw new WeakPassword('too_short', field);
    if (length > PASSWORD_MAX_LENGTH) throw new WeakPassword('too_long', field);

    const folded = raw.normalize('NFKC').toLowerCase();
    if (folded === email.value || folded === email.localPart) {
      throw new WeakPassword('matches_email', field);
    }
    if (isCommonPassword(folded)) throw new WeakPassword('common', field);
    return new PlainPassword(raw);
  }

  /** Never log or serialise a password. */
  toString(): string {
    return '[PlainPassword]';
  }

  toJSON(): string {
    return '[PlainPassword]';
  }
}
