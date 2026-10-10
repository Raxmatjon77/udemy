import { InvalidDisplayName } from './identity.errors';

const MIN_LENGTH = 1;
const MAX_LENGTH = 60;
const CONTROL_CHAR = /\p{Cc}/u;

/**
 * Public display name (design §4): trimmed, 1–60 characters, no control characters.
 * Length is counted in code points, like the DB CHECK `char_length(display_name)`.
 */
export class DisplayName {
  private constructor(readonly value: string) {}

  /** @throws InvalidDisplayName (422) */
  static parse(raw: string, field?: string): DisplayName {
    const value = raw.trim();
    const length = [...value].length;
    if (length < MIN_LENGTH || length > MAX_LENGTH || CONTROL_CHAR.test(value)) {
      throw new InvalidDisplayName(field);
    }
    return new DisplayName(value);
  }

  equals(other: DisplayName): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
