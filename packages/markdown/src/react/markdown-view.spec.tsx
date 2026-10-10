import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { findExecutableVectors } from '../testing/html-scan';
import { INERT, LEGIT, MALICIOUS } from '../testing/xss-corpus';
import { LINK_REL, MarkdownView } from './markdown-view';

/**
 * Wall-clock ceiling for one server render of up to 100 000 chars (render costs more than validate).
 * Like the validate budget it guards against quadratic blow-ups, with headroom for a loaded machine.
 * Override with MARKDOWN_RENDER_BUDGET_MS.
 */
const RENDER_BUDGET_MS = Number(process.env.MARKDOWN_RENDER_BUDGET_MS ?? 10_000);

function render(source: string): string {
  return renderToStaticMarkup(<MarkdownView source={source} />);
}

describe('<MarkdownView>: malicious corpus renders without executable vectors (validation bypassed)', () => {
  it.each(MALICIOUS.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const start = performance.now();
    const html = render(c.source);
    expect(performance.now() - start).toBeLessThan(RENDER_BUDGET_MS);
    expect(findExecutableVectors(html)).toEqual([]);
  });

  it('renders over-budget input as escaped plain text', () => {
    const html = render('- '.repeat(10_000) + '<b>x</b>');
    expect(html).toMatch(/<p class="whitespace-pre-wrap">(- )+&lt;b&gt;x&lt;\/b&gt;<\/p><\/div>$/);
  });
});

describe('html scanner self-test (the oracle must catch vectors)', () => {
  it.each([
    ['<script>alert(1)</script>', 'forbidden markup <script'],
    ['<img src="x">', 'forbidden markup <img'],
    ['<svg></svg>', 'forbidden markup <svg'],
    ['<p onclick="x()">a</p>', 'event handler onclick on <p>'],
    ['<p style="color:red">a</p>', 'style attribute on <p>'],
    ['<a href="javascript:alert(1)">a</a>', 'script URL'],
    ['<a href="jav&#x61;script:alert(1)">a</a>', 'script URL'],
    ['<a href="java&#9;script:alert(1)">a</a>', 'script URL'],
    ['<a href="/relative">a</a>', 'unsafe href'],
    ['<a href="https://x.example" target="_blank">a</a>', 'target=_blank without rel=noopener'],
    ['<p data-x="1">a</p>', 'attribute data-x on <p>'],
    ['<input type="text" disabled="">', 'input type text'],
    ['<input type="checkbox">', 'enabled <input>'],
    ['<x-foo>a</x-foo>', 'tag <x-foo>'],
    ['<!-- c -->', 'forbidden markup <!--'],
    ['<p>a</p><', 'unparsed markup'],
  ])('flags %s', (html, expected) => {
    expect(findExecutableVectors(html).join(' | ')).toContain(expected);
  });

  it('accepts escaped text that merely mentions vectors', () => {
    expect(
      findExecutableVectors(
        '<p>&lt;script&gt; javascript:alert(1) onerror=x style=&quot;&quot;</p>',
      ),
    ).toEqual([]);
  });
});

describe('<MarkdownView>: inert look-alikes render as escaped text', () => {
  it.each(INERT.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const html = render(c.source);
    expect(findExecutableVectors(html)).toEqual([]);
    expect(html).toContain(c.text);
  });
});

describe('<MarkdownView>: legitimate content renders correctly', () => {
  it.each(LEGIT.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const html = render(c.source);
    expect(findExecutableVectors(html)).toEqual([]);
    for (const fragment of c.html) expect(html).toContain(fragment);
  });

  it('never emits h1 or h2 for author headings', () => {
    const html = render('# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f');
    expect(html).not.toMatch(/<h[12][\s>]/);
    expect(html.match(/<h(\d)/g)).toEqual(['<h3', '<h4', '<h5', '<h6', '<h6', '<h6']);
  });

  it('opens http(s) links in a new tab with rel, mailto without target', () => {
    const html = render('[a](https://example.com) [m](mailto:x@example.com)');
    expect(html).toContain(
      `<a href="https://example.com/" class="font-medium text-primary underline underline-offset-4 hover:opacity-80" rel="${LINK_REL}" target="_blank">a</a>`,
    );
    expect(html).toMatch(
      /<a href="mailto:x@example.com" class="[^"]*" rel="noopener noreferrer nofollow ugc">m<\/a>/,
    );
  });

  it('keeps footnote links in-page (no target) and prefixes ids against DOM clobbering', () => {
    const html = render('Claim[^note].\n\n[^note]: Source.');
    expect(html).toMatch(/<a id="user-content-fnref-note"[^>]* href="#user-content-fn-note"/);
    expect(html).toContain('<li id="user-content-fn-note"');
    expect(html).toContain('href="#user-content-fnref-note"');
    expect(html).not.toMatch(/href="#[^"]*"[^>]*target=/);
    expect(html).not.toMatch(/id="(?!user-content-)/);
  });

  it('supports a per-view id prefix', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'A[^1]\n\n[^1]: B'} idPrefix="article-" />,
    );
    expect(html).toContain('id="article-fn-1"');
    expect(html).toContain('href="#article-fn-1"');
    expect(html).not.toContain('user-content-');
  });

  it('maps table alignment to classes, never inline styles', () => {
    const html = render('| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
    expect(html).not.toContain('style=');
    expect(html).toMatch(/<th class="[^"]*text-left[^"]*">L/);
    expect(html).toMatch(/<td class="[^"]*text-center[^"]*">2/);
    expect(html).toMatch(/<td class="[^"]*text-right[^"]*">3/);
  });

  it('renders unsafe links as plain text, keeping the label', () => {
    const html = render('[click me](javascript:alert(1)) [rel](/x) [img](data:text/html,x)');
    expect(html).not.toContain('<a');
    expect(html).toContain('<span>click me</span>');
    expect(html).toContain('<span>rel</span>');
  });

  it('drops images entirely', () => {
    expect(render('![alt](https://example.com/a.png)')).not.toContain('<img');
  });

  it('drops raw HTML entirely (skipHtml)', () => {
    const html = render('before <b onclick="x()">bold</b> after\n\n<div>block</div>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<b');
    expect(html).not.toContain('<div>block');
  });

  it('only allows language-* classes from code fences', () => {
    const html = render('```fixed inset-0 z-50\nx\n```');
    expect(html).toContain('language-fixed');
    expect(html).not.toMatch(/class="[^"]*\binset-0\b/);
  });

  it('merges a wrapper className', () => {
    expect(renderToStaticMarkup(<MarkdownView source="x" className="max-w-prose" />)).toMatch(
      /^<div class="[^"]*max-w-prose">/,
    );
  });

  it('renders a realistic 100 000-char article within the budget', () => {
    const section =
      '## Lesson\n\nSome *emphasis*, **strong**, `code` and a [link](https://example.com).\n\n' +
      '- a\n  - b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n';
    const source = section.repeat(Math.floor(100_000 / section.length));
    const start = performance.now();
    const html = render(source);
    expect(performance.now() - start).toBeLessThan(RENDER_BUDGET_MS);
    expect(findExecutableVectors(html)).toEqual([]);
  });
});
