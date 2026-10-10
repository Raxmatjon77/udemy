import {
  MarkdownTooComplexError,
  plainTextLength as markdownPlainTextLength,
  validateMarkdown,
} from '@udemy/markdown/validate';
import { MarkdownNotAllowed } from './catalog.errors';

/**
 * Author markdown on the write path (design D14): raw HTML, images and links other than
 * absolute http(s)/mailto are rejected with 422 `markdown_not_allowed`, one structured issue per
 * offending construct (`path` = the request field, plus line, column, kind, construct, detail).
 * The source is stored exactly as sent: never trimmed, never rewritten.
 *
 * @throws MarkdownNotAllowed
 */
export function assertMarkdownAllowed(field: string, source: string): void {
  const result = validateMarkdown(source);
  if (result.ok) return;
  throw new MarkdownNotAllowed(
    result.issues.map((issue) => ({
      path: field,
      line: issue.line,
      column: issue.column,
      kind: issue.kind,
      construct: issue.construct,
      detail: issue.detail,
    })),
  );
}

/**
 * Length of the text a reader sees (readiness: description >= 200, article >= 50 characters,
 * in code points like Postgres `char_length`): `@udemy/markdown/validate` `plainTextLength`,
 * from the same parse and cost guard as `validateMarkdown`, so it matches what is rendered.
 *
 * Only applied to markdown that already passed `assertMarkdownAllowed`, which rejects every
 * input that would make it throw `MarkdownTooComplexError` (`too_complex` / `too_deeply_nested`).
 * Should a stored text still trip the guard (e.g. after the guard is tightened), it counts as 0
 * characters: readiness then reports it as too short instead of the read failing with a 500,
 * and the author fixes it by saving the field again (which re-validates it).
 */
export function plainTextLength(markdown: string): number {
  try {
    return markdownPlainTextLength(markdown);
  } catch (error) {
    if (error instanceof MarkdownTooComplexError) return 0;
    throw error;
  }
}
