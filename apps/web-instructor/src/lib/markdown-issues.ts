import {
  ErrorCode,
  MarkdownNotAllowedProblemSchema,
  type MarkdownConstruct,
  type MarkdownIssueKind,
} from '@udemy/contracts';

import { isApiError } from './problem';

/**
 * One offending markdown construct from a 422 `markdown_not_allowed` problem (design D14).
 *
 * The API sends the structured `issues[]` (`{ path, line, column, kind, construct, detail }`,
 * contracts `MarkdownNotAllowedProblemSchema`). Older responses only carried field errors
 * (`errors: [{ path, message: 'Line 3, column 5: …' }]`); for those the position is parsed out
 * of the message, and messages without one are kept as they are.
 */
export interface MarkdownIssueView {
  /** The request field (`bodyMd`, `descriptionMd`). */
  path: string;
  line: number | null;
  column: number | null;
  /** Null for a legacy (message-only) issue. */
  kind: MarkdownIssueKind | null;
  construct: MarkdownConstruct | null;
  /** Plain text, safe to show to the author. */
  message: string;
}

const POSITION = /^Line (\d+), column (\d+):\s*(.*)$/s;

function inField(path: string, field: string | undefined): boolean {
  return field === undefined || path === '' || path.split('.')[0] === field;
}

export function markdownIssues(error: unknown, field?: string): MarkdownIssueView[] | null {
  if (!isApiError(error) || error.code !== ErrorCode.MarkdownNotAllowed) return null;

  const structured = MarkdownNotAllowedProblemSchema.safeParse(error.problem);
  if (structured.success) {
    return structured.data.issues
      .filter((issue) => inField(issue.path, field))
      .map((issue) => ({
        path: issue.path,
        line: issue.line,
        column: issue.column,
        kind: issue.kind,
        construct: issue.construct,
        message: issue.detail,
      }));
  }

  // Fallback for responses without `issues` (API before P2-T11).
  return (error.problem?.errors ?? [])
    .filter((issue) => inField(issue.path, field))
    .map((issue): MarkdownIssueView => {
      const match = POSITION.exec(issue.message);
      return match
        ? {
            path: issue.path,
            line: Number(match[1]),
            column: Number(match[2]),
            kind: null,
            construct: null,
            message: match[3]!,
          }
        : {
            path: issue.path,
            line: null,
            column: null,
            kind: null,
            construct: null,
            message: issue.message,
          };
    });
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
