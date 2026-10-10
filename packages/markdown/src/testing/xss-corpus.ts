/**
 * Table-driven XSS corpus run against BOTH layers (validate.spec.ts, markdown-view.spec.tsx).
 *
 * Sources: OWASP XSS Filter Evasion Cheat Sheet, PortSwigger XSS cheat sheet (event handlers,
 * SVG/MathML namespace confusion, mXSS), CommonMark/GFM-specific vectors (autolinks, reference
 * definitions, entity-encoded schemes, footnotes).
 *
 * - `MALICIOUS`: validateMarkdown must reject with EXACTLY the listed issue kinds (as a set);
 *   <MarkdownView> must render it without any executable vector.
 * - `INERT`: looks dangerous but is plain text / code in CommonMark; must PASS validation and render
 *   as escaped text.
 * - `LEGIT`: ordinary course content; must pass and render the expected markup.
 */
import type { MarkdownIssueKind } from '../validate';

export interface MaliciousCase {
  name: string;
  source: string;
  kinds: MarkdownIssueKind[];
}

export interface InertCase {
  name: string;
  source: string;
  /** Escaped text that must appear in the rendered HTML. */
  text: string;
}

export interface LegitCase {
  name: string;
  source: string;
  /** Substrings that must appear in the rendered HTML. */
  html: string[];
}

const RAW: MarkdownIssueKind[] = ['raw_html'];
const UNSAFE: MarkdownIssueKind[] = ['unsafe_link'];
const LINK: MarkdownIssueKind[] = ['disallowed_link'];
const IMAGE: MarkdownIssueKind[] = ['image'];

export const MALICIOUS: MaliciousCase[] = [
  // ---------------------------------------------------------------- raw HTML: block
  { name: 'script tag', source: '<script>alert(1)</script>', kinds: RAW },
  { name: 'script tag, mixed case', source: '<ScRiPt>alert(1)</sCrIpT>', kinds: RAW },
  {
    name: 'script src protocol-relative',
    source: '<SCRIPT SRC=//xss.example/x.js></SCRIPT>',
    kinds: RAW,
  },
  { name: 'img onerror', source: '<img src=x onerror=alert(1)>', kinds: RAW },
  { name: 'svg onload', source: '<svg onload=alert(1)>', kinds: RAW },
  { name: 'svg onload, newline separator', source: '<svg\nonload=alert(1)>', kinds: RAW },
  { name: 'svg script', source: '<svg><script>alert(1)</script></svg>', kinds: RAW },
  {
    name: 'svg animate href',
    source:
      '<svg><a><animate attributeName=href values=javascript:alert(1) /><text x=20 y=20>X</text></a></svg>',
    kinds: RAW,
  },
  {
    name: 'svg foreignObject',
    source: '<svg><foreignObject><iframe src=javascript:alert(1)></iframe></foreignObject></svg>',
    kinds: RAW,
  },
  {
    name: 'math mXSS (DOMPurify bypass shape)',
    source:
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
    kinds: RAW,
  },
  { name: 'math href', source: '<math href="javascript:alert(1)">CLICK</math>', kinds: RAW },
  {
    name: 'iframe javascript src',
    source: '<iframe src="javascript:alert(1)"></iframe>',
    kinds: RAW,
  },
  {
    name: 'iframe srcdoc',
    source: '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    kinds: RAW,
  },
  {
    name: 'object data URI',
    source: '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>',
    kinds: RAW,
  },
  { name: 'embed javascript', source: '<embed src=javascript:alert(1)>', kinds: RAW },
  { name: 'details ontoggle', source: '<details open ontoggle=alert(1)>', kinds: RAW },
  { name: 'body onload', source: '<body onload=alert(1)>', kinds: RAW },
  {
    name: 'style @import',
    source: "<style>@import 'https://evil.example/x.css';</style>",
    kinds: RAW,
  },
  {
    name: 'link stylesheet',
    source: '<link rel=stylesheet href=//evil.example/x.css>',
    kinds: RAW,
  },
  {
    name: 'meta refresh',
    source: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    kinds: RAW,
  },
  { name: 'base href hijack', source: '<base href="//evil.example/">', kinds: RAW },
  {
    name: 'form action',
    source: '<form action=javascript:alert(1)><button>x</button></form>',
    kinds: RAW,
  },
  {
    name: 'button formaction',
    source: '<button formaction=javascript:alert(1)>x</button>',
    kinds: RAW,
  },
  { name: 'input autofocus onfocus', source: '<input autofocus onfocus=alert(1)>', kinds: RAW },
  {
    name: 'div style url',
    source: '<div style="background:url(javascript:alert(1))">x</div>',
    kinds: RAW,
  },
  { name: 'anchor javascript href', source: '<a href="javascript:alert(1)">x</a>', kinds: RAW },
  { name: 'even a harmless anchor', source: '<a href="https://example.com">ok</a>', kinds: RAW },
  { name: 'even a harmless br', source: 'line one<br>line two', kinds: RAW },
  { name: 'video source onerror', source: '<video><source onerror=alert(1)></video>', kinds: RAW },
  { name: 'audio onerror', source: '<audio src=x onerror=alert(1)>', kinds: RAW },
  { name: 'marquee onstart', source: '<marquee onstart=alert(1)>x</marquee>', kinds: RAW },
  { name: 'custom element onclick', source: '<x-foo onclick=alert(1)>click</x-foo>', kinds: RAW },
  {
    name: 'noscript title breakout',
    source: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    kinds: RAW,
  },
  { name: 'template script', source: '<template><script>alert(1)</script></template>', kinds: RAW },
  {
    name: 'textarea breakout',
    source: '<textarea></textarea><script>alert(1)</script>',
    kinds: RAW,
  },
  { name: 'nested split script', source: '<scr<script>ipt>alert(1)</script>', kinds: RAW },
  { name: 'double open bracket', source: '<<script>alert(1);//<</script>', kinds: RAW },
  { name: 'attribute with newline', source: '<img\nsrc=x\nonerror=alert(1)>', kinds: RAW },
  { name: 'HTML comment', source: '<!-- hidden -->', kinds: RAW },
  { name: 'comment breakout', source: '<!--><script>alert(1)</script>-->', kinds: RAW },
  {
    name: 'conditional comment',
    source: '<!--[if gte IE 4]><script>alert(1)</script><![endif]-->',
    kinds: RAW,
  },
  { name: 'CDATA', source: '<![CDATA[<script>alert(1)</script>]]>', kinds: RAW },
  { name: 'processing instruction', source: '<?xml version="1.0"?>', kinds: RAW },
  { name: 'doctype declaration', source: '<!DOCTYPE html>', kinds: RAW },
  // ---------------------------------------------------------------- raw HTML: inline / nested in markdown
  { name: 'inline script', source: 'Hello <script>alert(1)</script> world', kinds: RAW },
  { name: 'inline img', source: 'text <img src=x onerror=alert(1)> more', kinds: RAW },
  { name: 'inline comment', source: 'a <!-- c --> b', kinds: RAW },
  { name: 'html in strong', source: '**bold <span onmouseover=alert(1)>x</span>**', kinds: RAW },
  { name: 'html in emphasis split', source: '*<script>*alert(1)*</script>*', kinds: RAW },
  {
    name: 'html in link text',
    source: '[<img src=x onerror=alert(1)>](https://example.com)',
    kinds: RAW,
  },
  { name: 'html in heading', source: '# Title <script>alert(1)</script>', kinds: RAW },
  { name: 'html in list item', source: '- item <svg onload=alert(1)>', kinds: RAW },
  { name: 'html in quote', source: '> quote <iframe src=//evil.example></iframe>', kinds: RAW },
  { name: 'html block in quote', source: '> <script>alert(1)</script>', kinds: RAW },
  {
    name: 'html in table cell',
    source: '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
    kinds: RAW,
  },
  { name: 'html in task item', source: '- [ ] task <b onmouseover=alert(1)>x</b>', kinds: RAW },
  { name: 'html in strikethrough', source: '~~<u onclick=alert(1)>x</u>~~', kinds: RAW },
  {
    name: 'html in footnote',
    source: 'Text[^1]\n\n[^1]: <img src=x onerror=alert(1)>',
    kinds: RAW,
  },
  // ---------------------------------------------------------------- images
  { name: 'image https', source: '![x](https://example.com/a.png)', kinds: IMAGE },
  { name: 'image javascript', source: '![x](javascript:alert(1))', kinds: IMAGE },
  {
    name: 'image data svg',
    source: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
    kinds: IMAGE,
  },
  {
    name: 'image alt payload',
    source: '![" onerror="alert(1)](https://example.com/a.png)',
    kinds: IMAGE,
  },
  {
    name: 'image title payload',
    source: '![x](https://example.com/a.png "a\\" onerror=\\"alert(1)")',
    kinds: IMAGE,
  },
  {
    name: 'image reference',
    source: '![x][logo]\n\n[logo]: https://example.com/a.png',
    kinds: IMAGE,
  },
  {
    name: 'image collapsed reference',
    source: '![logo][]\n\n[logo]: https://example.com/a.png',
    kinds: IMAGE,
  },
  {
    name: 'image reference to javascript',
    source: '![x][r]\n\n[r]: javascript:alert(1)',
    kinds: ['image', 'unsafe_link'],
  },
  {
    name: 'image inside link',
    source: '[![x](https://example.com/a.png)](https://example.com)',
    kinds: IMAGE,
  },
  {
    name: 'image in table',
    source: '| a |\n|---|\n| ![x](https://example.com/a.png) |',
    kinds: IMAGE,
  },
  {
    name: 'image in footnote',
    source: 'Text[^1]\n\n[^1]: ![x](https://example.com/a.png)',
    kinds: IMAGE,
  },
  // ---------------------------------------------------------------- javascript:/vbscript:/data: links
  { name: 'javascript link', source: '[x](javascript:alert(1))', kinds: UNSAFE },
  { name: 'javascript link, title case', source: '[x](JavaScript:alert(1))', kinds: UNSAFE },
  { name: 'javascript link, upper case', source: '[x](JAVASCRIPT:alert(1))', kinds: UNSAFE },
  { name: 'hex entity in scheme', source: '[x](jav&#x61;script:alert(1))', kinds: UNSAFE },
  { name: 'decimal entity in scheme', source: '[x](jav&#97;script:alert(1))', kinds: UNSAFE },
  {
    name: 'fully entity-encoded scheme',
    source: '[x](&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1))',
    kinds: UNSAFE,
  },
  {
    name: 'zero-padded entities',
    source: '[x](&#0000106;&#0000097;vascript:alert(1))',
    kinds: UNSAFE,
  },
  { name: 'named &colon; entity', source: '[x](javascript&colon;alert(1))', kinds: UNSAFE },
  { name: 'tab entity inside scheme', source: '[x](java&#9;script:alert(1))', kinds: UNSAFE },
  { name: 'newline entity inside scheme', source: '[x](java&#10;script:alert(1))', kinds: UNSAFE },
  { name: 'CR entity inside scheme', source: '[x](java&#13;script:alert(1))', kinds: UNSAFE },
  {
    name: 'raw tab inside scheme (angle destination)',
    source: '[x](<java\tscript:alert(1)>)',
    kinds: UNSAFE,
  },
  { name: 'leading space entity', source: '[x](&#32;javascript:alert(1))', kinds: UNSAFE },
  { name: 'angle-bracket destination', source: '[x](<javascript:alert(1)>)', kinds: UNSAFE },
  { name: 'escaped parens payload', source: '[x](javascript:alert\\(1\\))', kinds: UNSAFE },
  { name: 'javascript with comment trick', source: '[x](javascript://%0aalert(1))', kinds: UNSAFE },
  { name: 'javascript with title', source: '[x](javascript:alert(1) "title")', kinds: UNSAFE },
  { name: 'vbscript', source: '[x](vbscript:msgbox(1))', kinds: UNSAFE },
  { name: 'vbscript mixed case', source: '[x](VbScRiPt:msgbox(1))', kinds: UNSAFE },
  { name: 'livescript', source: '[x](livescript:alert(1))', kinds: UNSAFE },
  {
    name: 'data text/html base64',
    source: '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    kinds: UNSAFE,
  },
  {
    name: 'data text/html inline',
    source: '[x](data:text/html,<script>alert(1)</script>)',
    kinds: UNSAFE,
  },
  { name: 'DATA upper case', source: '[x](DATA:text/html,x)', kinds: UNSAFE },
  { name: 'javascript in strong', source: '**[x](javascript:alert(1))**', kinds: UNSAFE },
  { name: 'javascript in heading', source: '## [x](javascript:alert(1))', kinds: UNSAFE },
  { name: 'javascript in quote+list', source: '> - [x](javascript:alert(1))', kinds: UNSAFE },
  {
    name: 'javascript in table',
    source: '| a |\n|---|\n| [x](javascript:alert(1)) |',
    kinds: UNSAFE,
  },
  {
    name: 'javascript in footnote',
    source: 'Text[^1]\n\n[^1]: [x](javascript:alert(1))',
    kinds: UNSAFE,
  },
  { name: 'javascript in task item', source: '- [x] [done](javascript:alert(1))', kinds: UNSAFE },
  // ---------------------------------------------------------------- other disallowed links
  {
    name: 'control char entity becomes U+FFFD (relative)',
    source: '[x](&#x01;javascript:alert(1))',
    kinds: LINK,
  },
  {
    name: 'NUL entity becomes U+FFFD (relative)',
    source: '[x](&#0;javascript:alert(1))',
    kinds: LINK,
  },
  { name: 'percent-encoded colon (relative)', source: '[x](javascript%3Aalert(1))', kinds: LINK },
  {
    name: 'entity without semicolons (relative)',
    source: '[x](&#x6A&#x61vascript:alert(1))',
    kinds: LINK,
  },
  { name: 'file scheme', source: '[x](file:///etc/passwd)', kinds: LINK },
  { name: 'ftp scheme', source: '[x](ftp://example.com/a)', kinds: LINK },
  { name: 'tel scheme', source: '[x](tel:+15550100)', kinds: LINK },
  { name: 'blob scheme', source: '[x](blob:https://example.com/uuid)', kinds: LINK },
  { name: 'intent scheme', source: '[x](intent://scan/#Intent;scheme=zxing;end)', kinds: LINK },
  { name: 'relative path', source: '[x](/admin/delete)', kinds: LINK },
  { name: 'protocol-relative', source: '[x](//evil.example)', kinds: LINK },
  { name: 'backslash protocol-relative', source: '[x](\\\\evil.example)', kinds: LINK },
  { name: 'fragment', source: '[x](#user-content-fn-1)', kinds: LINK },
  { name: 'query only', source: '[x](?a=b)', kinds: LINK },
  { name: 'empty destination', source: '[x]()', kinds: LINK },
  { name: 'empty angle destination', source: '[x](<>)', kinds: LINK },
  { name: 'malformed http', source: '[x](http://)', kinds: LINK },
  // ---------------------------------------------------------------- autolinks
  { name: 'autolink javascript', source: '<javascript:alert(1)>', kinds: UNSAFE },
  { name: 'autolink JAVASCRIPT', source: '<JAVASCRIPT:alert(1)>', kinds: UNSAFE },
  { name: 'autolink vbscript', source: '<vbscript:msgbox(1)>', kinds: UNSAFE },
  { name: 'autolink data', source: '<data:text/html;base64,PHNjcmlwdD4=>', kinds: UNSAFE },
  { name: 'autolink javascript in text', source: 'click <javascript:alert(1)> now', kinds: UNSAFE },
  { name: 'autolink file', source: '<file:///etc/passwd>', kinds: LINK },
  { name: 'autolink ftp', source: '<ftp://example.com>', kinds: LINK },
  { name: 'autolink custom scheme', source: '<steam://run/1>', kinds: LINK },
  // ---------------------------------------------------------------- reference definitions
  { name: 'reference javascript', source: '[x][r]\n\n[r]: javascript:alert(1)', kinds: UNSAFE },
  { name: 'unused definition javascript', source: '[r]: javascript:alert(1)', kinds: UNSAFE },
  {
    name: 'shortcut reference, entity scheme',
    source: '[x]\n\n[x]: jav&#x61;script:alert(1)',
    kinds: UNSAFE,
  },
  {
    name: 'definition angle data with title',
    source: '[x][r]\n\n[r]: <data:text/html,x> "t"',
    kinds: UNSAFE,
  },
  { name: 'case-insensitive label', source: '[x]\n\n[X]: vbscript:x', kinds: UNSAFE },
  { name: 'definition relative', source: '[x][r]\n\n[r]: /relative', kinds: LINK },
  {
    name: 'definition inside quote',
    source: '> [r]: javascript:alert(1)\n>\n> [x][r]',
    kinds: UNSAFE,
  },
  // ---------------------------------------------------------------- mixes
  {
    name: 'link + html + image in one doc',
    source: '[x](javascript:alert(1)) and <b>x</b> and ![i](https://example.com/i.png)',
    kinds: ['unsafe_link', 'raw_html', 'image'],
  },
  {
    name: 'nested quote list html link',
    source: '> 1. <em>x</em>\n>    - [y](ftp://example.com)',
    kinds: ['raw_html', 'disallowed_link'],
  },
  // ---------------------------------------------------------------- pathological structure
  { name: '10 000 nested quotes', source: '>'.repeat(10_000) + ' x', kinds: ['too_deeply_nested'] },
  {
    name: '10 000 list markers on one line',
    source: '- '.repeat(10_000) + 'x',
    kinds: ['too_deeply_nested'],
  },
  {
    name: '25 000 nested emphasis',
    source: '*'.repeat(25_000) + 'a' + '*'.repeat(25_000),
    kinds: ['too_complex'],
  },
  { name: '30 000 **_ runs', source: '**_'.repeat(30_000), kinds: ['too_complex'] },
  { name: '20 000 [a]( openers', source: '[a]('.repeat(20_000), kinds: ['too_complex'] },
  {
    name: '16 000 `- - x` lines (32 000 list items)',
    source: '- - x\n'.repeat(16_000),
    kinds: ['too_complex'],
  },
  {
    name: '70 nested lists by indentation',
    source: Array.from({ length: 70 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\n'),
    kinds: ['too_deeply_nested'],
  },
];

export const INERT: InertCase[] = [
  {
    name: 'anchor in code span',
    source: '`<a href="javascript:alert(1)">x</a>`',
    text: '&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;',
  },
  {
    name: 'markdown link in code span',
    source: '`[x](javascript:alert(1))`',
    text: '[x](javascript:alert(1))',
  },
  {
    name: 'script in fenced code',
    source: '```html\n<script>alert(1)</script>\n```',
    text: '&lt;script&gt;alert(1)&lt;/script&gt;',
  },
  {
    name: 'script in indented code',
    source: '    <img src=x onerror=alert(1)>',
    text: '&lt;img src=x onerror=alert(1)&gt;',
  },
  {
    name: 'backslash-escaped tag',
    source: '\\<script>alert(1)\\</script>',
    text: '&lt;script&gt;alert(1)&lt;/script&gt;',
  },
  {
    name: 'entity-encoded tag',
    source: '&lt;script&gt;alert(1)&lt;/script&gt;',
    text: '&lt;script&gt;alert(1)&lt;/script&gt;',
  },
  {
    name: 'numeric-entity tag',
    source: '&#60;img src=x onerror=alert(1)&#62;',
    text: '&lt;img src=x onerror=alert(1)&gt;',
  },
  {
    name: 'space after <',
    source: '< script>alert(1)</ script>',
    text: '&lt; script&gt;alert(1)&lt;/ script&gt;',
  },
  {
    name: 'javascript: in prose',
    source: 'Never paste javascript:alert(1) into the address bar.',
    text: 'javascript:alert(1)',
  },
  { name: 'undefined reference stays text', source: '[click][nowhere]', text: '[click][nowhere]' },
  // Not HTML in CommonMark (an attribute must follow whitespace), so these stay text.
  {
    name: 'img with slash separators',
    source: '<img/src/onerror=alert(1)>',
    text: '&lt;img/src/onerror=alert(1)&gt;',
  },
  {
    name: 'svg with slash separator',
    source: '<svg/onload=alert(1)>',
    text: '&lt;svg/onload=alert(1)&gt;',
  },
  {
    name: 'image-looking link with javascript in code',
    source: '`![x](javascript:alert(1))`',
    text: '![x](javascript:alert(1))',
  },
  {
    name: 'event handler text',
    source: 'onerror=alert(1) onload=alert(1)',
    text: 'onerror=alert(1) onload=alert(1)',
  },
  { name: 'style text', source: 'style="color:red"', text: 'style=&quot;color:red&quot;' },
];

export const LEGIT: LegitCase[] = [
  { name: 'h1 is shifted to h3', source: '# Course intro', html: ['<h3', '>Course intro</h3>'] },
  { name: 'h2 is shifted to h4', source: '## Section', html: ['<h4', '>Section</h4>'] },
  { name: 'h3 is shifted to h5', source: '### Sub', html: ['<h5'] },
  { name: 'h6 stays h6', source: '###### Deep', html: ['<h6'] },
  { name: 'setext heading', source: 'Title\n=====', html: ['<h3'] },
  {
    name: 'emphasis',
    source: '**bold** _italic_ ~~gone~~',
    html: ['<strong>bold</strong>', '<em>italic</em>', '<del>gone</del>'],
  },
  { name: 'unordered list', source: '- one\n- two', html: ['<ul', '<li', '>one</li>'] },
  { name: 'ordered list with start', source: '3. three\n4. four', html: ['<ol start="3"'] },
  { name: 'nested list', source: '- a\n  - b\n    - c', html: ['<ul', '>c</li>'] },
  {
    name: 'task list',
    source: '- [x] done\n- [ ] todo',
    html: ['type="checkbox"', 'checked=""', 'disabled=""'],
  },
  {
    name: 'table with alignment',
    source: '| Left | Right |\n|:-----|------:|\n| a | b |',
    html: ['<table', 'text-left', 'text-right'],
  },
  {
    name: 'fenced code with language',
    source: '```ts\nconst a = 1 < 2;\n```',
    html: ['<pre', 'language-ts', 'const a = 1 &lt; 2;'],
  },
  { name: 'indented code', source: '    npm install', html: ['<pre', 'npm install'] },
  { name: 'inline code', source: 'Run `npm test` now', html: ['<code', '>npm test</code>'] },
  { name: 'blockquote', source: '> Quote', html: ['<blockquote'] },
  { name: 'thematic break', source: 'a\n\n---\n\nb', html: ['<hr'] },
  { name: 'hard break', source: 'line one  \nline two', html: ['<br/>'] },
  {
    name: 'https link',
    source: '[Docs](https://example.com/docs)',
    html: [
      '<a href="https://example.com/docs"',
      'rel="noopener noreferrer nofollow ugc"',
      'target="_blank"',
    ],
  },
  {
    name: 'http link',
    source: '[Old](http://example.com)',
    html: ['href="http://example.com/"', 'target="_blank"'],
  },
  {
    name: 'link with title',
    source: '[x](https://example.com "Example")',
    html: ['title="Example"'],
  },
  {
    name: 'mailto link',
    source: '[Mail](mailto:help@example.com)',
    html: ['href="mailto:help@example.com"', 'rel="noopener noreferrer nofollow ugc"'],
  },
  {
    name: 'autolink https',
    source: '<https://example.com/a?b=1&c=2>',
    html: ['href="https://example.com/a?b=1&amp;c=2"'],
  },
  {
    name: 'autolink email',
    source: '<help@example.com>',
    html: ['href="mailto:help@example.com"'],
  },
  {
    name: 'GFM www literal',
    source: 'see www.example.com',
    html: ['href="http://www.example.com/"'],
  },
  {
    name: 'GFM https literal',
    source: 'see https://example.com/x',
    html: ['href="https://example.com/x"'],
  },
  {
    name: 'GFM email literal',
    source: 'mail help@example.com',
    html: ['href="mailto:help@example.com"'],
  },
  {
    name: 'reference link',
    source: '[docs][d]\n\n[d]: https://example.com/d',
    html: ['href="https://example.com/d"'],
  },
  {
    name: 'footnote',
    source: 'Claim[^1].\n\n[^1]: Source.',
    html: [
      'data-footnote-ref',
      'href="#user-content-fn-1"',
      'data-footnotes',
      'id="user-content-fn-1"',
    ],
  },
  {
    name: 'escaped image syntax is "!" + a link',
    source: '\\![x](https://example.com/a.png)',
    html: ['>!<a href="https://example.com/a.png"'],
  },
  {
    name: 'unicode text',
    source: "O'zbekcha matn — ✓ 日本語",
    html: ['O&#x27;zbekcha matn — ✓ 日本語'],
  },
];
