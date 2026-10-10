/**
 * `@udemy/markdown/validate`: the API write-path check for author markdown (design D14, §9 XSS).
 *
 * Node-safe: no React, no DOM. Compiled to `dist/` (ESM) so the CommonJS api can load it through
 * Node's `require(esm)`.
 *
 * The source is parsed with micromark (CommonMark + GFM), i.e. the same parser family and versions
 * that react-markdown/remark-gfm use on the render path, so "what we checked" is "what gets
 * rendered". The mdast tree is then walked against an allowlist:
 * - raw HTML (block, inline, comments, CDATA, processing instructions, declarations): rejected;
 * - images (inline and reference): rejected;
 * - links, autolinks and link reference definitions: only absolute `http:`, `https:`, `mailto:`.
 *
 * Rejecting (rather than silently stripping) tells the author exactly what to fix.
 */
import type { Nodes, Parents } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { checkComplexity } from './complexity.js';
import { classifyUrl, type UrlRejectionReason } from './url-policy.js';

export const MARKDOWN_ISSUE_KINDS = [
  /** Raw HTML of any kind: tags, comments, CDATA, `<?...?>`, `<!DOCTYPE>`. */
  'raw_html',
  /** Image syntax (`![alt](src)`, `![alt][ref]`). Images are not allowed in author markdown. */
  'image',
  /** A link to a script-capable scheme: `javascript:`, `vbscript:`, `data:`, `livescript:`. */
  'unsafe_link',
  /** Any other link that is not an absolute `http:`/`https:`/`mailto:` URL (relative, `ftp:`...). */
  'disallowed_link',
  /** Nesting deeper than `MAX_NESTING_DEPTH` (or the per-line container limits in complexity.ts). */
  'too_deeply_nested',
  /** Exceeds a parser cost budget (e.g. thousands of emphasis markers in one paragraph). */
  'too_complex',
  /** An mdast node type outside the allowlist (should not happen with CommonMark + GFM). */
  'unsupported_syntax',
] as const;

export type MarkdownIssueKind = (typeof MARKDOWN_ISSUE_KINDS)[number];

/** The markdown construct an issue points at (for the author-facing 422 message). */
export type MarkdownConstruct =
  | 'html_block'
  | 'html_inline'
  | 'image'
  | 'image_reference'
  | 'link'
  /** `<scheme:...>` (CommonMark autolink). */
  | 'autolink'
  /** `www.x.com`, `https://x.com`, `a@b.c` in plain text (GFM autolink literal). */
  | 'literal_autolink'
  /** `[label]: url` (link reference definition). */
  | 'definition'
  | 'document'
  | 'other';

export interface MarkdownIssue {
  kind: MarkdownIssueKind;
  construct: MarkdownConstruct;
  /** 1-based, from the parser's positional info. */
  line: number;
  /** 1-based. */
  column: number;
  /** Human-readable explanation, safe to show to the author (plain text, truncated). */
  detail: string;
}

export type MarkdownValidationResult = { ok: true } | { ok: false; issues: MarkdownIssue[] };

/**
 * Maximum mdast tree depth. Real content (a list in a quote in a list, with emphasis and a link)
 * stays well under 20; the limit protects the recursive render pipeline (to-hast, sanitize,
 * to-jsx-runtime) from pathological input such as 10 000 nested `>`.
 */
export const MAX_NESTING_DEPTH = 64;

/** Bounds the 422 payload; the author fixes the first ones and resubmits. */
export const MAX_REPORTED_ISSUES = 50;

const SNIPPET_MAX = 60;

/** Node types CommonMark + GFM can produce that are allowed as such (links/html/images checked separately). */
const ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  'root',
  'paragraph',
  'heading',
  'thematicBreak',
  'blockquote',
  'list',
  'listItem',
  'table',
  'tableRow',
  'tableCell',
  'code',
  'inlineCode',
  'emphasis',
  'strong',
  'delete',
  'break',
  'text',
  'linkReference',
  'footnoteDefinition',
  'footnoteReference',
]);

/** Containers in which an `html` node is a block (type 1-7 HTML block) rather than inline HTML. */
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set([
  'root',
  'blockquote',
  'listItem',
  'footnoteDefinition',
]);

function snippet(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX)}…` : oneLine;
}

function linkDetail(reason: UrlRejectionReason, scheme: string | undefined): string {
  switch (reason) {
    case 'empty':
      return 'Link has no URL; use an absolute http, https or mailto URL';
    case 'relative':
      return 'Relative links are not allowed; use an absolute http, https or mailto URL';
    case 'malformed':
      return 'Link URL is malformed';
    case 'unsafe_scheme':
      return `Link scheme "${scheme}" is not allowed (script-capable)`;
    case 'scheme_not_allowed':
      return `Link scheme "${scheme}" is not allowed; use http, https or mailto`;
  }
}

function linkConstruct(source: string, node: Nodes): MarkdownConstruct {
  const offset = node.position?.start.offset;
  if (offset === undefined) return 'link';
  const first = source.charAt(offset);
  if (first === '<') return 'autolink';
  if (first === '[') return 'link';
  return 'literal_autolink';
}

/**
 * Validates author markdown. Never throws for string input (parser stack exhaustion, which the
 * complexity guard should already prevent, is reported as `too_complex`). Length limits are enforced by the contracts schemas, not here.
 */
export function validateMarkdown(source: string): MarkdownValidationResult {
  if (typeof source !== 'string') throw new TypeError('validateMarkdown expects a string');

  // Bound the parser's CPU time first (see complexity.ts); the parse below is then cheap.
  const tooComplex = checkComplexity(source);
  if (tooComplex) {
    return { ok: false, issues: [{ ...tooComplex, construct: 'document' }] };
  }

  let tree: ReturnType<typeof fromMarkdown>;
  try {
    tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        ok: false,
        issues: [
          {
            kind: 'too_complex',
            construct: 'document',
            line: 1,
            column: 1,
            detail: 'The document is too complex to process',
          },
        ],
      };
    }
    throw error;
  }

  const issues: MarkdownIssue[] = [];
  let depthReported = false;
  const report = (node: Nodes, issue: Omit<MarkdownIssue, 'line' | 'column'>): void => {
    if (issues.length >= MAX_REPORTED_ISSUES) return;
    const start = node.position?.start;
    issues.push({ ...issue, line: start?.line ?? 1, column: start?.column ?? 1 });
  };
  const checkUrl = (node: Nodes, url: string, construct: MarkdownConstruct): void => {
    const verdict = classifyUrl(url);
    if (verdict.ok) return;
    report(node, {
      kind: verdict.reason === 'unsafe_scheme' ? 'unsafe_link' : 'disallowed_link',
      construct,
      detail: linkDetail(verdict.reason, verdict.scheme),
    });
  };

  // Iterative DFS: the tree depth is attacker-controlled, so no recursion here.
  const stack: Array<{ node: Nodes; parent: Parents | null; depth: number }> = [
    { node: tree, parent: null, depth: 0 },
  ];
  while (stack.length > 0 && issues.length < MAX_REPORTED_ISSUES) {
    const { node, parent, depth } = stack.pop()!;

    if (depth > MAX_NESTING_DEPTH) {
      if (!depthReported) {
        depthReported = true;
        report(node, {
          kind: 'too_deeply_nested',
          construct: 'document',
          detail: `Nesting deeper than ${MAX_NESTING_DEPTH} levels is not allowed`,
        });
      }
      continue;
    }

    switch (node.type) {
      case 'html':
        report(node, {
          kind: 'raw_html',
          construct: parent && BLOCK_CONTAINERS.has(parent.type) ? 'html_block' : 'html_inline',
          detail: `Raw HTML is not allowed: ${snippet(node.value)}`,
        });
        break;
      case 'image':
        report(node, { kind: 'image', construct: 'image', detail: 'Images are not allowed' });
        break;
      case 'imageReference':
        report(node, {
          kind: 'image',
          construct: 'image_reference',
          detail: 'Images are not allowed',
        });
        break;
      case 'link':
        checkUrl(node, node.url, linkConstruct(source, node));
        break;
      case 'definition':
        checkUrl(node, node.url, 'definition');
        break;
      default:
        if (!ALLOWED_NODE_TYPES.has(node.type)) {
          report(node, {
            kind: 'unsupported_syntax',
            construct: 'other',
            detail: `Unsupported markdown construct: ${node.type}`,
          });
        }
    }

    if ('children' in node) {
      // Push in reverse so issues come out in document order.
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i] as Nodes, parent: node, depth: depth + 1 });
      }
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
