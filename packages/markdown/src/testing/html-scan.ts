/**
 * Tiny scanner for the HTML that `renderToStaticMarkup(<MarkdownView/>)` produces. Test-only.
 *
 * React escapes `<`, `>`, `&`, `"` and `'` in text and attribute values, so every literal `<` in its
 * output starts a real tag and every attribute value is double-quoted. That makes a strict
 * allowlist scan reliable here (it would NOT be a safe way to sanitize arbitrary HTML).
 */
import { classifyUrl } from '../url-policy';

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'div',
  'p',
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
  'span',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'input',
  'sup',
  'section',
]);

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'class',
  'href',
  'title',
  'rel',
  'target',
  'id',
  'aria-describedby',
  'aria-label',
  'data-footnote-ref',
  'data-footnote-backref',
  'data-footnotes',
  'type',
  'disabled',
  'checked',
  'readonly',
  'start',
  'align',
]);

/** Literal markers that must never appear in the output at all (as tags/constructs). */
const FORBIDDEN_MARKUP = [
  '<script',
  '<img',
  '<iframe',
  '<frame',
  '<svg',
  '<math',
  '<style',
  '<object',
  '<embed',
  '<link',
  '<meta',
  '<base',
  '<form',
  '<button',
  '<textarea',
  '<select',
  '<video',
  '<audio',
  '<source',
  '<template',
  '<details',
  '<marquee',
  '<noscript',
  '<!--',
  '<![cdata[',
  '<?',
  '<!doctype',
];

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Returns human-readable violations; an empty array means no executable vector was found. */
export function findExecutableVectors(html: string): string[] {
  const problems: string[] = [];
  const lower = html.toLowerCase();
  for (const marker of FORBIDDEN_MARKUP) {
    if (lower.includes(marker)) problems.push(`forbidden markup ${marker}`);
  }

  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  const attrPattern = /\s+([^\s=>/]+)(?:="([^"]*)")?/g;
  for (const match of html.matchAll(tagPattern)) {
    const [, closing, rawName, attrs] = match;
    const name = rawName!.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) problems.push(`tag <${name}>`);
    if (closing) continue;
    for (const attr of attrs!.matchAll(attrPattern)) {
      const attrName = attr[1]!.toLowerCase();
      const value = decodeEntities(attr[2] ?? '');
      if (attrName.startsWith('on')) problems.push(`event handler ${attrName} on <${name}>`);
      else if (attrName === 'style') problems.push(`style attribute on <${name}>`);
      else if (!ALLOWED_ATTRIBUTES.has(attrName))
        problems.push(`attribute ${attrName} on <${name}>`);
      if (attrName === 'href') {
        const verdict = classifyUrl(value, { allowFragment: true });
        if (!verdict.ok) problems.push(`unsafe href ${JSON.stringify(value)} (${verdict.reason})`);
        if (/^\s*(javascript|vbscript|data|livescript):/i.test(value.replace(/[\t\n\r]/g, ''))) {
          problems.push(`script URL ${JSON.stringify(value)}`);
        }
      }
      if (attrName === 'class' && !/^[\w\s:[\]&>.()%/#-]*$/.test(value)) {
        problems.push(`odd class value ${JSON.stringify(value)}`);
      }
      if (name === 'input' && attrName === 'type' && value !== 'checkbox') {
        problems.push(`input type ${value}`);
      }
    }
    if (name === 'input' && !/\sdisabled=""/.test(attrs!)) problems.push('enabled <input>');
    if (name === 'a' && /\starget="_blank"/.test(attrs!) && !/\srel="[^"]*noopener/.test(attrs!)) {
      problems.push('target=_blank without rel=noopener');
    }
  }
  // Anything still starting with `<` was not a well-formed tag.
  const rest = html.replace(tagPattern, '');
  if (rest.includes('<'))
    problems.push(
      `unparsed markup near ${JSON.stringify(rest.slice(rest.indexOf('<'), rest.indexOf('<') + 40))}`,
    );
  return problems;
}
