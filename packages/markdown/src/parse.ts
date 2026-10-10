/**
 * The ONE parser configuration for the Node-side entry (`validate`, `plain-text`): micromark
 * CommonMark + GFM into mdast, the same family/versions react-markdown + remark-gfm render with.
 * Callers MUST run `checkComplexity` first (see complexity.ts); this function does not.
 */
import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

/**
 * Maximum mdast tree depth. Real content (a list in a quote in a list, with emphasis and a link)
 * stays well under 20; the limit protects the recursive render pipeline (to-hast, sanitize,
 * to-jsx-runtime) from pathological input such as 10 000 nested `>`.
 */
export const MAX_NESTING_DEPTH = 64;

/** @throws RangeError on parser stack exhaustion (the complexity guard should prevent it). */
export function parseMarkdownTree(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}
