import { NOTIFICATION_EXCERPT_MAX_CHARS } from '@udemy/contracts';
import { markdownPlainText } from '@udemy/markdown/validate';

/**
 * Plain-text snapshots for notification payloads and e-mails (design D22): user-authored
 * markdown is reduced to its reader-visible text with the SAME parser the api validated it with
 * (`markdownPlainText`), whitespace runs collapse to one space, and lengths are counted in code
 * points (like Postgres `char_length` and the contracts' zod `max`).
 */

/** At most `max` code points; a cut text ends with `…` (still within `max`). */
export function clampText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** One line, trimmed, at most `max` code points; null when nothing is left. */
export function excerptOfPlainText(
  text: string | null | undefined,
  max: number = NOTIFICATION_EXCERPT_MAX_CHARS,
): string | null {
  if (text === null || text === undefined) return null;
  const line = text.replace(/\s+/g, ' ').trim();
  return line === '' ? null : clampText(line, max);
}

/**
 * The visible text of stored markdown as an excerpt. Stored markdown passed `validateMarkdown`,
 * so the cost guard never trips; if it ever does, the excerpt is simply omitted (null).
 */
export function excerptOfMarkdown(
  markdown: string | null | undefined,
  max: number = NOTIFICATION_EXCERPT_MAX_CHARS,
): string | null {
  if (markdown === null || markdown === undefined) return null;
  try {
    return excerptOfPlainText(markdownPlainText(markdown), max);
  } catch {
    return null;
  }
}
