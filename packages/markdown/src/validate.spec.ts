import { describe, expect, it } from 'vitest';
import { INERT, LEGIT, MALICIOUS } from './testing/xss-corpus';
import { classifyUrl } from './url-policy';
import {
  MARKDOWN_ISSUE_KINDS,
  MAX_REPORTED_ISSUES,
  validateMarkdown,
  type MarkdownIssue,
} from './validate';

/**
 * Wall-clock ceiling for one validateMarkdown call on any input up to the 100 000-char limit.
 * It exists to catch a quadratic blow-up (an unguarded worst case takes 14-15 s or overflows the
 * stack), not to benchmark: guarded inputs take <= ~0.5 s on an idle machine but 2-3x that while
 * turbo builds Next apps in parallel, so a tight bound flakes. Override with MARKDOWN_VALIDATE_BUDGET_MS.
 */
const VALIDATE_BUDGET_MS = Number(process.env.MARKDOWN_VALIDATE_BUDGET_MS ?? 6_000);

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

function issuesOf(source: string): MarkdownIssue[] {
  const result = validateMarkdown(source);
  return result.ok ? [] : result.issues;
}

describe('validateMarkdown: malicious corpus', () => {
  it.each(MALICIOUS.map((c) => [c.name, c] as const))('rejects %s', (_name, c) => {
    const { result, ms } = timed(() => validateMarkdown(c.source));
    expect(ms).toBeLessThan(VALIDATE_BUDGET_MS);
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect([...new Set(issues.map((i) => i.kind))].sort()).toEqual([...new Set(c.kinds)].sort());
    for (const issue of issues) {
      expect(MARKDOWN_ISSUE_KINDS).toContain(issue.kind);
      expect(issue.line).toBeGreaterThanOrEqual(1);
      expect(issue.column).toBeGreaterThanOrEqual(1);
      expect(issue.detail.length).toBeGreaterThan(0);
      expect(issue.detail.length).toBeLessThan(200);
    }
  });
});

describe('validateMarkdown: inert look-alikes pass', () => {
  it.each(INERT.map((c) => [c.name, c] as const))('accepts %s', (_name, c) => {
    expect(validateMarkdown(c.source)).toEqual({ ok: true });
  });
});

describe('validateMarkdown: legitimate content passes', () => {
  it.each(LEGIT.map((c) => [c.name, c] as const))('accepts %s', (_name, c) => {
    expect(validateMarkdown(c.source)).toEqual({ ok: true });
  });

  it('accepts a realistic 100 000-char article quickly', () => {
    const section = [
      '## Lesson',
      '',
      'Some *emphasis*, **strong** text, `inline code` and a [link](https://example.com/docs).',
      'A second line with ~~strikethrough~~ and a footnote[^n].',
      '',
      '- point one',
      '  - nested point with a_snake_case name',
      '- point two',
      '',
      '1. first',
      '2. second',
      '',
      '| Col A | Col B |',
      '|:------|------:|',
      '| a | b |',
      '',
      '```python',
      'def my_func(a_b, *args, **kwargs):',
      '    return a_b * 2',
      '```',
      '',
      '> Note: see <https://example.com> or mail help@example.com.',
      '',
    ].join('\n');
    const source = (section.repeat(Math.ceil(100_000 / section.length)) + '\n[^n]: Note.\n').slice(
      -100_000,
    );
    const { result, ms } = timed(() => validateMarkdown('[^n]: Note.\n\n' + source));
    expect(result).toEqual({ ok: true });
    expect(ms).toBeLessThan(VALIDATE_BUDGET_MS);
  });
});

describe('validateMarkdown: positions and details', () => {
  it('reports line/column of each construct in document order', () => {
    const issues = issuesOf(
      'ok\n\n<b>x</b>\n\nsee [x](javascript:alert(1))\n\n![i](https://a.example/i.png)',
    );
    expect(
      issues.map(({ kind, construct, line, column }) => ({ kind, construct, line, column })),
    ).toEqual([
      { kind: 'raw_html', construct: 'html_inline', line: 3, column: 1 },
      { kind: 'raw_html', construct: 'html_inline', line: 3, column: 5 },
      { kind: 'unsafe_link', construct: 'link', line: 5, column: 5 },
      { kind: 'image', construct: 'image', line: 7, column: 1 },
    ]);
  });

  it('classifies html blocks vs inline html', () => {
    expect(issuesOf('<div>\nx\n</div>')[0]?.construct).toBe('html_block');
    expect(issuesOf('a <i>b</i>')[0]?.construct).toBe('html_inline');
  });

  it('classifies link constructs', () => {
    expect(issuesOf('<ftp://x.example>')[0]?.construct).toBe('autolink');
    expect(issuesOf('[a](ftp://x.example)')[0]?.construct).toBe('link');
    expect(issuesOf('[a]: ftp://x.example')[0]?.construct).toBe('definition');
  });

  it('names the scheme in the detail', () => {
    expect(issuesOf('[x](jav&#x61;script:alert(1))')[0]?.detail).toContain('"javascript:"');
    expect(issuesOf('[x](ftp://example.com)')[0]?.detail).toContain('"ftp:"');
  });

  it('truncates the raw HTML snippet', () => {
    const detail = issuesOf(`<div title="${'a'.repeat(500)}">`)[0]?.detail ?? '';
    expect(detail.length).toBeLessThan(120);
    expect(detail.endsWith('…')).toBe(true);
  });

  it(`caps the number of issues at ${MAX_REPORTED_ISSUES}`, () => {
    expect(issuesOf('<b>x</b>\n\n'.repeat(500))).toHaveLength(MAX_REPORTED_ISSUES);
  });

  it('rejects non-string input loudly', () => {
    expect(() => validateMarkdown(42 as unknown as string)).toThrow(TypeError);
  });
});

describe('validateMarkdown: performance and pathological input', () => {
  const big = (unit: string): string => unit.repeat(Math.floor(100_000 / unit.length));
  const shapes: Array<[string, string]> = [
    ['100k plain text', big('lorem ipsum dolor sit amet ')],
    ['100k `[` openers', '['.repeat(100_000)],
    ['100k `<`', '<'.repeat(100_000)],
    ['100k backticks', '`'.repeat(100_000)],
    ['100k `*` (one run, thematic-break-like)', '*'.repeat(100_000)],
    ['emphasis openers only', big('*a ')],
    ['many short emphasis paragraphs', big('*a'.repeat(150) + '\n\n')],
    ['many short strikethrough paragraphs', big('~a'.repeat(200) + '\n\n')],
    ['16 nested quotes per line', big('> '.repeat(16) + 'x\n')],
    ['1 999 list items', '- x\n'.repeat(1_999)],
    ['500 four-level nested lists', '- a\n  - b\n    - c\n      - d\n'.repeat(500)],
    [
      'wide table',
      [
        '|' + 'h|'.repeat(2_000),
        '|' + '-|'.repeat(2_000),
        ...Array.from({ length: 20 }, () => '|' + 'c|'.repeat(2_000)),
      ].join('\n'),
    ],
    [
      '5 000 definitions',
      Array.from({ length: 5_000 }, (_, i) => `[r${i}]: https://e.example/${i}`)
        .join('\n')
        .slice(0, 100_000),
    ],
    [
      '3 000 footnotes',
      Array.from({ length: 3_000 }, (_, i) => `x[^f${i}]`).join(' ') +
        '\n\n' +
        Array.from({ length: 3_000 }, (_, i) => `[^f${i}]: n`).join('\n'),
    ],
    ['GFM literal autolinks', big('www.a.example ')],
    ['entity references', big('&#x41;')],
    ['unclosed html-ish', big('<a ')],
    ['every issue kind repeated', big('<b>x</b> [x](javascript:x) ![i](https://a.example/i)\n\n')],
    [
      '70 nested lists by indentation',
      Array.from({ length: 70 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\n'),
    ],
    ['3 500 nested emphasis', '*'.repeat(3_500) + 'a' + '*'.repeat(3_500)],
    ['10 000 nested quotes', '>'.repeat(10_000) + ' x'],
    ['10 000 list markers on one line', '- '.repeat(10_000) + 'x'],
    ['30 000 **_ runs', '**_'.repeat(30_000)],
    ['one 100k paragraph of a*b', big('const x = a*b*c + d*e;\n')],
  ];

  it.each(shapes)('%s stays within the time budget and does not throw', (_name, source) => {
    expect(source.length).toBeLessThanOrEqual(100_010);
    const { ms } = timed(() => validateMarkdown(source));
    expect(ms).toBeLessThan(VALIDATE_BUDGET_MS);
  });
});

describe('classifyUrl (shared link policy)', () => {
  it.each([
    ['https://example.com', true],
    ['HTTP://EXAMPLE.COM', true],
    ['mailto:a@b.example', true],
    [' https://example.com ', true],
    ['javascript:alert(1)', false],
    ['\u0001javascript:alert(1)', false],
    ['java\tscript:alert(1)', false],
    ['java\nscript:alert(1)', false],
    ['  JaVaScRiPt:alert(1)', false],
    ['data:text/html,x', false],
    ['//evil.example', false],
    ['#frag', false],
    ['', false],
  ])('%j -> ok=%s', (url, ok) => {
    expect(classifyUrl(url).ok).toBe(ok);
  });

  it('sees through C0/tab/newline tricks the way the browser does', () => {
    expect(classifyUrl('\u0001java\tscr\nipt:alert(1)')).toMatchObject({
      ok: false,
      reason: 'unsafe_scheme',
      scheme: 'javascript:',
    });
  });

  it('allows fragments only when asked (renderer footnotes)', () => {
    expect(classifyUrl('#user-content-fn-1', { allowFragment: true })).toEqual({
      ok: true,
      href: '#user-content-fn-1',
      external: false,
    });
  });

  it('returns the normalized href', () => {
    expect(classifyUrl('https://exa\tmple.com')).toMatchObject({
      ok: true,
      href: 'https://example.com/',
    });
  });
});
