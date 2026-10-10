/**
 * Exact reader-visible text of author markdown (readiness: description >= 200, article >= 50
 * characters), from the SAME parse as `validateMarkdown` (parse.ts) behind the SAME cost guard
 * (complexity.ts) and depth limit, so a count can never disagree with what is rendered.
 *
 * Text is mdast `toString` (mdast-util-to-string) of every leaf block (paragraph, heading,
 * table cell, code block), without raw HTML or image alt text (both are rejected on the write
 * path and never rendered as text). Leaf blocks are joined with a space, a hard line break
 * counts as a space, and whitespace runs collapse to one space (trimmed), so `# A\n\nB` is
 * `A B`. Not text: markup (`#`, `>`, `-`, `*`, `_`, `~`, backticks, pipes, escapes), link and
 * definition destinations, task-list boxes, thematic breaks.
 */
import type { Nodes, Parents, Root } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { checkComplexity, type ComplexityViolation } from './complexity.js';
import { MAX_NESTING_DEPTH, parseMarkdownTree } from './parse.js';

/**
 * Thrown when the source fails the cost guard or the nesting limit, i.e. exactly when
 * `validateMarkdown` reports `too_complex` / `too_deeply_nested`. Markdown that passed
 * `validateMarkdown` never throws it.
 */
export class MarkdownTooComplexError extends Error {
  constructor(
    readonly kind: ComplexityViolation['kind'],
    readonly line: number,
    readonly column: number,
    readonly detail: string,
  ) {
    super(`markdown ${kind} at ${line}:${column}: ${detail}`);
    this.name = 'MarkdownTooComplexError';
  }
}

/** Blocks whose (inline) content is text the reader sees. */
const LEAF_BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading', 'tableCell', 'code']);

const TO_STRING_OPTIONS = { includeImageAlt: false, includeHtml: false } as const;

function leafText(node: Nodes): string {
  if (!('children' in node)) return toString(node, TO_STRING_OPTIONS);
  let text = '';
  for (const child of node.children) {
    text += child.type === 'break' ? ' ' : toString(child, TO_STRING_OPTIONS);
  }
  return text;
}

function parseGuarded(source: string): Root {
  if (typeof source !== 'string') throw new TypeError('markdownPlainText expects a string');
  const violation = checkComplexity(source);
  if (violation) {
    throw new MarkdownTooComplexError(
      violation.kind,
      violation.line,
      violation.column,
      violation.detail,
    );
  }
  try {
    return parseMarkdownTree(source);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new MarkdownTooComplexError(
        'too_complex',
        1,
        1,
        'The document is too complex to process',
      );
    }
    throw error;
  }
}

/**
 * The visible text of `source` (see the module comment for the exact rules).
 *
 * @throws MarkdownTooComplexError when the cost guard or nesting limit trips
 */
export function markdownPlainText(source: string): string {
  const tree = parseGuarded(source);
  const parts: string[] = [];
  // Iterative DFS with the validate depth limit, so toString's recursion below is bounded too.
  const stack: Array<{ node: Nodes; depth: number }> = [{ node: tree, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_NESTING_DEPTH) {
      const start = node.position?.start;
      throw new MarkdownTooComplexError(
        'too_deeply_nested',
        start?.line ?? 1,
        start?.column ?? 1,
        `Nesting deeper than ${MAX_NESTING_DEPTH} levels is not allowed`,
      );
    }
    if (LEAF_BLOCKS.has(node.type)) {
      if (!hasDeeperThan(node, MAX_NESTING_DEPTH - depth)) {
        parts.push(leafText(node));
        continue;
      }
    }
    if ('children' in node) {
      const parent = node as Parents;
      for (let i = parent.children.length - 1; i >= 0; i--) {
        stack.push({ node: parent.children[i] as Nodes, depth: depth + 1 });
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** True when `node` has a descendant more than `limit` levels below it (iterative). */
function hasDeeperThan(node: Nodes, limit: number): boolean {
  const stack: Array<{ node: Nodes; depth: number }> = [{ node, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > limit) return true;
    if ('children' in current.node) {
      for (const child of current.node.children) {
        stack.push({ node: child as Nodes, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

/**
 * `markdownPlainText(source)` length in Unicode code points, like Postgres `char_length`.
 *
 * @throws MarkdownTooComplexError when the cost guard or nesting limit trips
 */
export function plainTextLength(source: string): number {
  return Array.from(markdownPlainText(source)).length;
}
