import { validateMarkdown } from '@udemy/markdown/validate';
import { MarkdownNotAllowed } from './catalog.errors';

/**
 * Author markdown on the write path (design D14): raw HTML, images and links other than
 * absolute http(s)/mailto are rejected with 422 `markdown_not_allowed`, one issue per offending
 * construct (`path` = the request field). The source is stored exactly as sent: never trimmed,
 * never rewritten.
 *
 * @throws MarkdownNotAllowed
 */
export function assertMarkdownAllowed(field: string, source: string): void {
  const result = validateMarkdown(source);
  if (result.ok) return;
  throw new MarkdownNotAllowed(
    result.issues.map((issue) => ({
      path: field,
      message: `Line ${issue.line}, column ${issue.column}: ${issue.detail} (${issue.kind}).`,
    })),
  );
}

/**
 * Approximate length of the text a reader sees (readiness: description ≥ 200, article ≥ 50
 * characters, counted in code points like Postgres `char_length`). Removes markdown syntax that
 * renders as nothing: fenced-code fences, heading/quote/list markers, emphasis and code
 * delimiters, link and reference-definition URLs, table pipes and escapes; then collapses
 * whitespace. Only applied to markdown that already passed `assertMarkdownAllowed`.
 */
export function plainTextLength(markdown: string): number {
  const text = markdown
    // link reference definitions: `[label]: url "title"` render as nothing
    .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+.*$/gm, ' ')
    // fences of fenced code blocks (the code itself is visible text)
    .replace(/^[ \t]{0,3}(`{3,}|~{3,}).*$/gm, ' ')
    // thematic breaks
    .replace(/^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/gm, ' ')
    // ATX heading markers, block quote markers, list markers, task boxes
    .replace(/^[ \t]*(#{1,6}[ \t]+|>[ \t]?)+/gm, '')
    .replace(/^[ \t]*([-+*]|\d{1,9}[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '')
    // setext underlines
    .replace(/^[ \t]{0,3}(=+|-+)[ \t]*$/gm, ' ')
    // inline links / autolinks: keep the text, drop the destination
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    .replace(/<((?:https?:|mailto:)[^>\s]*)>/gi, '$1')
    // table delimiter rows and pipes
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/\|/g, ' ')
    // emphasis / strike / code delimiters and backslash escapes
    .replace(/(\*{1,3}|_{1,3}|~{1,2}|`+)/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).length;
}
