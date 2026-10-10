import type { Options as SanitizeSchema } from 'rehype-sanitize';

/**
 * Strict rehype-sanitize schema (design §9): an explicit allowlist, NOT `defaultSchema`.
 *
 * It covers exactly what CommonMark + GFM produce through remark-rehype (no raw HTML is ever
 * parsed: `skipHtml`, no rehype-raw), minus images. Everything else is dropped. Notably:
 * - no `img`, `iframe`, `svg`, `math`, `style`, `form`... (not in `tagNames`);
 * - no `style`, `on*`, `src` attributes (not in `attributes`);
 * - `className` only where remark-rehype sets fixed values, plus `language-*` on code;
 * - `id`/`aria-*` references get the `user-content-` clobber prefix (DOM clobbering);
 * - `href` protocols: http, https, mailto (relative = footnote fragments only, enforced again by
 *   the `urlTransform` in markdown-view.tsx).
 */
export const strictSanitizeSchema: SanitizeSchema = {
  tagNames: [
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'del',
    'code',
    'pre',
    'hr',
    'br',
    'a',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    // GFM task list checkbox (disabled, see `required`).
    'input',
    // GFM footnotes.
    'sup',
    'section',
  ],
  attributes: {
    a: [
      'href',
      'title',
      'id',
      'ariaDescribedBy',
      'ariaLabel',
      'dataFootnoteRef',
      'dataFootnoteBackref',
      ['className', 'data-footnote-backref'],
    ],
    code: [['className', /^language-[\w+#.-]+$/]],
    // Footnotes label (`<h2 class="sr-only" id="footnote-label">`).
    h2: ['id', ['className', 'sr-only']],
    input: [['disabled', true], ['type', 'checkbox'], 'checked'],
    li: ['id', ['className', 'task-list-item']],
    ol: ['start', ['className', 'contains-task-list']],
    ul: [['className', 'contains-task-list']],
    section: ['dataFootnotes', ['className', 'footnotes']],
    th: ['align'],
    td: ['align'],
  },
  required: { input: { disabled: true, type: 'checkbox' } },
  ancestors: {
    tbody: ['table'],
    td: ['table'],
    th: ['table'],
    thead: ['table'],
    tr: ['table'],
  },
  clobber: ['ariaDescribedBy', 'ariaLabelledBy', 'id', 'name'],
  clobberPrefix: 'user-content-',
  protocols: { href: ['http', 'https', 'mailto'] },
  strip: ['script', 'style'],
};
