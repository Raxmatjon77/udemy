import { describe, expect, it } from 'vitest';
import { MAX_LIST_MARKERS } from './complexity';
import {
  markdownPlainText,
  MarkdownTooComplexError,
  MAX_NESTING_DEPTH,
  plainTextLength,
  validateMarkdown,
} from './validate';

/**
 * Ceiling for one markdownPlainText call on pathological input up to 100 000 chars. Like the
 * validate budget it catches quadratic blow-ups (unguarded: 14-15 s), with headroom for a loaded
 * machine (a full parallel turbo run measured 3.75 s). Override with MARKDOWN_PLAIN_TEXT_BUDGET_MS.
 */
const PLAIN_TEXT_BUDGET_MS = Number(process.env.MARKDOWN_PLAIN_TEXT_BUDGET_MS ?? 6_000);

describe('markdownPlainText: only visible text counts', () => {
  it.each([
    // emphasis, strong, strikethrough, escapes
    ['**bold** and _em_ and ~~gone~~', 'bold and em and gone'],
    ['***both*** __strong__ *a*b*c*', 'both strong abc'],
    ['\\*not emphasis\\* \\# x', '*not emphasis* # x'],
    // headings (ATX and setext) and paragraphs are separate blocks
    ['# Title\n\n**bold** and _em_', 'Title bold and em'],
    ['Title\n=====\n\nBody', 'Title Body'],
    // links: text only, never the destination
    ['See [the docs](https://example.com/a/very/long/path "Title").', 'See the docs.'],
    ['See [the docs][ref].\n\n[ref]: https://example.com/long', 'See the docs.'],
    ['Visit <https://example.com>', 'Visit https://example.com'],
    ['Visit www.example.com now', 'Visit www.example.com now'],
    ['[**bold link**](https://x.test)', 'bold link'],
    // code: inline and block content is visible, fences/backticks/info strings are not
    ['Use `npm i` here', 'Use npm i here'],
    ['``a ` b``', 'a ` b'],
    ['```ts\nconst x = 1;\n```', 'const x = 1;'],
    ['    indented code', 'indented code'],
    // lists (bullets, ordered, tasks, nested)
    ['- one\n- two\n1. three', 'one two three'],
    ['- [x] done\n- [ ] todo', 'done todo'],
    ['- a\n  - b\n    - c', 'a b c'],
    // block quotes and thematic breaks
    ['> quoted\n\n---\n\n[ref]: https://x.test', 'quoted'],
    // tables: cell text only, no pipes or delimiter row
    ['| A | B |\n| --- | :-: |\n| 1 | **2** |', 'A B 1 2'],
    // hard breaks and soft breaks are spaces; whitespace collapses
    ['line one  \nline two\\\nthree\nfour', 'line one line two three four'],
    ['   \n\n  ', ''],
    ['', ''],
  ])('%j -> %j', (source, expected) => {
    expect(markdownPlainText(source)).toBe(expected);
    expect(plainTextLength(source)).toBe(Array.from(expected).length);
  });

  it('drops raw HTML and image alt text (rejected on write, never rendered as text)', () => {
    expect(markdownPlainText('a <b>x</b> c')).toBe('a x c');
    expect(markdownPlainText('<div>\nblock\n</div>\n\nafter')).toBe('after');
    expect(markdownPlainText('see ![alt text](https://x.test/i.png) here')).toBe('see here');
  });

  it('counts code points like Postgres char_length', () => {
    expect(plainTextLength('😀😀')).toBe(2);
    expect(plainTextLength('**ü**ñ')).toBe(2);
  });

  it('matches a realistic course description exactly', () => {
    const source = [
      '## What you will learn',
      '',
      'Build **production-ready** APIs with [NestJS](https://nestjs.com).',
      '',
      '- Modules & DI',
      '- `Kysely` queries',
      '',
      '> Tip: practise daily.',
    ].join('\n');
    const expected =
      'What you will learn Build production-ready APIs with NestJS. Modules & DI Kysely queries Tip: practise daily.';
    expect(markdownPlainText(source)).toBe(expected);
    expect(plainTextLength(source)).toBe(expected.length);
  });
});

describe('markdownPlainText: the same cost guard as validateMarkdown', () => {
  it('throws MarkdownTooComplexError exactly where validateMarkdown reports too_complex', () => {
    const source = '- x\n'.repeat(MAX_LIST_MARKERS + 1);
    const verdict = validateMarkdown(source);
    expect(verdict.ok).toBe(false);
    expect(() => markdownPlainText(source)).toThrow(MarkdownTooComplexError);
    try {
      plainTextLength(source);
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownTooComplexError);
      expect((error as MarkdownTooComplexError).kind).toBe(
        verdict.ok ? undefined : verdict.issues[0]?.kind,
      );
    }
  });

  const big = (unit: string): string => unit.repeat(Math.floor(100_000 / unit.length));
  const pathological: Array<[string, string]> = [
    [
      '70 nested lists by indentation',
      Array.from({ length: 70 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\n'),
    ],
    ['3 500 nested emphasis', '*'.repeat(3_500) + 'a' + '*'.repeat(3_500)],
    ['10 000 nested quotes', '>'.repeat(10_000) + ' x'],
    ['10 000 list markers on one line', '- '.repeat(10_000) + 'x'],
    ['30 000 **_ runs', '**_'.repeat(30_000)],
    ['one 100k paragraph of a*b', big('const x = a*b*c + d*e;\n')],
    ['16 nested quotes per line', big('> '.repeat(16) + 'x\n')],
    ['500 four-level nested lists', '- a\n  - b\n    - c\n      - d\n'.repeat(500)],
    ['100k `[` openers', '['.repeat(100_000)],
  ];

  it.each(pathological)(
    '%s: throws iff validateMarkdown reports too_complex/too_deeply_nested, within budget',
    (_name, source) => {
      const verdict = validateMarkdown(source);
      const guardKind = verdict.ok
        ? undefined
        : verdict.issues.find((i) => i.kind === 'too_complex' || i.kind === 'too_deeply_nested')
            ?.kind;
      const started = performance.now();
      let thrown: unknown;
      try {
        markdownPlainText(source);
      } catch (error) {
        thrown = error;
      }
      expect(performance.now() - started).toBeLessThan(PLAIN_TEXT_BUDGET_MS);
      if (guardKind === undefined) {
        expect(thrown).toBeUndefined();
      } else {
        expect(thrown).toBeInstanceOf(MarkdownTooComplexError);
        expect((thrown as MarkdownTooComplexError).kind).toBe(guardKind);
      }
    },
  );

  it('the nesting limit is the validate one', () => {
    expect(MAX_NESTING_DEPTH).toBe(64);
  });

  it('never throws for markdown that passed validateMarkdown', () => {
    const fine = '# A\n\n' + '- item with *em* and [link](https://x.test)\n'.repeat(500);
    expect(validateMarkdown(fine).ok).toBe(true);
    expect(plainTextLength(fine)).toBeGreaterThan(0);
  });

  it('rejects non-string input', () => {
    expect(() => markdownPlainText(42 as unknown as string)).toThrow(TypeError);
  });
});
