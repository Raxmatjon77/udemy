import { InvalidUsersField } from './users.errors';

const CONTROL_CHAR = /\p{Cc}/u;
const LINE_BREAK_OR_TAB = /[\t\n\r]/g;

/** Length in Unicode code points, like PostgreSQL's `char_length` (not UTF-16 units). */
export function charLength(value: string): number {
  return [...value].length;
}

export interface TextRule {
  readonly field: string;
  readonly min: number;
  readonly max: number;
  /** Allow tab/CR/LF (bio, motivation, reasons); other control characters never pass. */
  readonly multiline: boolean;
}

/**
 * Trims and checks a free-text field against the DB CHECK of its column.
 * @throws InvalidUsersField (422 `validation_failed`)
 */
export function parseText(raw: string, rule: TextRule): string {
  const value = raw.trim();
  const length = charLength(value);
  if (length < rule.min || length > rule.max) {
    throw new InvalidUsersField({
      path: rule.field,
      message: `Must be between ${rule.min} and ${rule.max} characters.`,
    });
  }
  const checked = rule.multiline ? value.replace(LINE_BREAK_OR_TAB, '') : value;
  if (CONTROL_CHAR.test(checked)) {
    throw new InvalidUsersField({
      path: rule.field,
      message: 'Must not contain control characters.',
    });
  }
  return value;
}
