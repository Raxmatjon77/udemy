import { validateMarkdown } from '@udemy/markdown/validate';
import { MarkdownNotAllowed } from './engagement.errors';

/**
 * User-generated markdown on the write path (design D22, Q&A and announcement bodies): raw
 * HTML, images and links other than absolute http(s)/mailto are rejected with 422
 * `markdown_not_allowed`, one structured issue per offending construct. The source is stored
 * exactly as sent. Same rules as catalog's author markdown (`@udemy/markdown/validate`).
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
