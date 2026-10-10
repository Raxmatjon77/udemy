import { describe, expect, it } from 'vitest';
import { MarkdownNotAllowedProblemSchema } from '@udemy/contracts';
import { ProxyFetchError } from '@udemy/web-auth/client';

import { markdownIssues, offsetOf } from './markdown-issues';

/** A structured 422 exactly as the API sends it (parsed with the contracts schema). */
const structured = MarkdownNotAllowedProblemSchema.parse({
  type: 'about:blank',
  title: 'Unprocessable Entity',
  status: 422,
  code: 'markdown_not_allowed',
  // The generic field errors stay in the body; the structured `issues` win.
  errors: [
    { path: 'bodyMd', message: 'Raw HTML is not allowed.' },
    { path: 'descriptionMd', message: 'Images are not allowed.' },
  ],
  issues: [
    {
      path: 'bodyMd',
      line: 3,
      column: 5,
      kind: 'raw_html',
      construct: 'html_inline',
      detail: 'Raw HTML is not allowed.',
    },
    {
      path: 'descriptionMd',
      line: 1,
      column: 1,
      kind: 'image',
      construct: 'image',
      detail: 'Images are not allowed.',
    },
  ],
});

/** A response from before the structured `issues` (positions only inside the message). */
const legacy = new ProxyFetchError(422, {
  type: 'about:blank',
  title: 'Unprocessable',
  status: 422,
  code: 'markdown_not_allowed',
  errors: [
    { path: 'bodyMd', message: 'Line 3, column 5: Raw HTML is not allowed (raw_html).' },
    { path: 'bodyMd', message: 'Something without a position' },
    { path: 'descriptionMd', message: 'Line 1, column 1: Images are not allowed (image).' },
  ],
});

describe('markdownIssues', () => {
  it('uses the structured issues of one field (line, column, kind, construct, detail)', () => {
    expect(markdownIssues(new ProxyFetchError(422, structured), 'bodyMd')).toEqual([
      {
        path: 'bodyMd',
        line: 3,
        column: 5,
        kind: 'raw_html',
        construct: 'html_inline',
        message: 'Raw HTML is not allowed.',
      },
    ]);
    expect(markdownIssues(new ProxyFetchError(422, structured))).toHaveLength(2);
  });

  it('falls back to parsing line and column from older field-error messages', () => {
    expect(markdownIssues(legacy, 'bodyMd')).toEqual([
      {
        path: 'bodyMd',
        line: 3,
        column: 5,
        kind: null,
        construct: null,
        message: 'Raw HTML is not allowed (raw_html).',
      },
      {
        path: 'bodyMd',
        line: null,
        column: null,
        kind: null,
        construct: null,
        message: 'Something without a position',
      },
    ]);
  });

  it('ignores other problems', () => {
    expect(markdownIssues(new ProxyFetchError(409, null))).toBeNull();
    expect(markdownIssues(new Error('x'))).toBeNull();
  });

  it('maps line/column to a caret offset', () => {
    const source = 'ab\ncdef\ngh';
    expect(offsetOf(source, 1, 1)).toBe(0);
    expect(offsetOf(source, 2, 3)).toBe(5);
    expect(offsetOf(source, 9, 1)).toBe(source.length);
  });
});
