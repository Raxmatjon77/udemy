import { describe, expect, it } from 'vitest';
import { ProxyFetchError } from '@udemy/web-auth/client';

import { markdownIssues, offsetOf } from './markdown-issues';

const markdownProblem = new ProxyFetchError(422, {
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
  it('parses line and column from the api field errors of one field', () => {
    expect(markdownIssues(markdownProblem, 'bodyMd')).toEqual([
      { path: 'bodyMd', line: 3, column: 5, message: 'Raw HTML is not allowed (raw_html).' },
      { path: 'bodyMd', line: null, column: null, message: 'Something without a position' },
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
