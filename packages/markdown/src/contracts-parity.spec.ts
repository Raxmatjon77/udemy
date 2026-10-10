import { MARKDOWN_CONSTRUCTS, MARKDOWN_ISSUE_KINDS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_ISSUE_KINDS as KINDS, type MarkdownConstruct } from './validate';

/**
 * `@udemy/contracts` `MarkdownNotAllowedProblem` mirrors this package's issue vocabulary (the
 * contracts cannot depend on this package). Adding a kind/construct here must add it there.
 */
const CONSTRUCTS = {
  html_block: true,
  html_inline: true,
  image: true,
  image_reference: true,
  link: true,
  autolink: true,
  literal_autolink: true,
  definition: true,
  document: true,
  other: true,
} satisfies Record<MarkdownConstruct, true>;

describe('contracts parity', () => {
  it('issue kinds', () => {
    expect([...MARKDOWN_ISSUE_KINDS]).toEqual([...KINDS]);
  });

  it('constructs', () => {
    expect([...MARKDOWN_CONSTRUCTS].sort()).toEqual(Object.keys(CONSTRUCTS).sort());
  });
});
