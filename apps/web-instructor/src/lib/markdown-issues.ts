import { ErrorCode } from '@udemy/contracts';

import { isApiError } from './problem';

/**
 * One offending markdown construct from a 422 `markdown_not_allowed` problem (design D14).
 *
 * Contract note: the api reports each construct as a field error,
 * `errors: [{ path: 'bodyMd', message: 'Line 3, column 5: Raw HTML is not allowed (raw_html).' }]`,
 * so line and column are parsed out of the message. Messages without a position are kept as is.
 */
export interface MarkdownIssueView {
  /** The request field (`bodyMd`, `descriptionMd`). */
  path: string;
  line: number | null;
  column: number | null;
  message: string;
}

const POSITION = /^Line (\d+), column (\d+):\s*(.*)$/s;

export function markdownIssues(error: unknown, field?: string): MarkdownIssueView[] | null {
  if (!isApiError(error) || error.code !== ErrorCode.MarkdownNotAllowed) return null;
  const errors = error.problem?.errors ?? [];
  const issues = errors
    .filter((issue) => field === undefined || issue.path === '' || issue.path.split('.')[0] === field)
    .map((issue): MarkdownIssueView => {
      const match = POSITION.exec(issue.message);
      return match
        ? { path: issue.path, line: Number(match[1]), column: Number(match[2]), message: match[3]! }
        : { path: issue.path, line: null, column: null, message: issue.message };
    });
  return issues;
}

/** The character offset of a 1-based line/column in `source` (for moving the caret there). */
export function offsetOf(source: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
  }
  return Math.min(offset + Math.max(0, column - 1), source.length);
}
