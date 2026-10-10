import { InvalidEmail } from './identity.errors';

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;
/** Whitespace, control characters, and characters that are never valid unquoted in an address. */
const FORBIDDEN = /[\s\p{Cc}<>()[\]\\,;:"]/u;
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;

/**
 * Email address value object (design §4): trimmed, NFKC-normalised and lowercased; at most
 * 254 characters with a local part of at most 64. Provider-specific rewriting (gmail dots,
 * `+tags`) is deliberately NOT applied: those are distinct addresses.
 *
 * Lengths are counted in UTF-16 code units, like the DB CHECK on `email` (citext length) and
 * the HTTP schema; after NFKC an address is ASCII in practice.
 */
export class Email {
  private constructor(readonly value: string) {}

  /** @throws InvalidEmail (422) */
  static parse(raw: string, field?: string): Email {
    const value = raw.trim().normalize('NFKC').toLowerCase();
    const at = value.lastIndexOf('@');
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const valid =
      at > 0 &&
      value.length <= MAX_EMAIL_LENGTH &&
      local.length <= MAX_LOCAL_PART_LENGTH &&
      !local.includes('@') &&
      !FORBIDDEN.test(value) &&
      !local.startsWith('.') &&
      !local.endsWith('.') &&
      !local.includes('..') &&
      domain.length <= MAX_DOMAIN_LENGTH &&
      domain.includes('.') &&
      domain.split('.').every((label) => DOMAIN_LABEL.test(label));
    if (!valid) throw new InvalidEmail(field);
    return new Email(value);
  }

  /** The part before the `@`. */
  get localPart(): string {
    return this.value.slice(0, this.value.lastIndexOf('@'));
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
