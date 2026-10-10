/**
 * `@udemy/markdown/react`: `<MarkdownView source>` (design D14, §9, §10).
 *
 * Second, independent XSS layer behind `validateMarkdown`: even content that never went through
 * the API check renders without executable vectors.
 * - react-markdown builds React elements (no `dangerouslySetInnerHTML`, React escapes all text);
 * - `skipHtml`: raw HTML nodes are dropped, and rehype-raw is never used;
 * - rehype-sanitize with a strict allowlist schema (./sanitize-schema.ts): no images, no styles,
 *   no event handlers, href protocols http/https/mailto only;
 * - `urlTransform` re-checks every URL with the same WHATWG-based policy as the validator and
 *   renders the normalized URL; a link whose URL fails becomes plain text;
 * - links get `rel="noopener noreferrer nofollow ugc"`; http(s) links open in a new tab;
 * - headings are shifted down two levels (`#` -> h3 ... capped at h6): the page owns h1/h2;
 * - the validator's linear cost guard runs first; input over budget renders as escaped plain text.
 *
 * No hooks, no 'use client': it renders synchronously, so it works in Server Components (course
 * landing page, article previews; react-markdown's default export is sync and RSC-safe) and in
 * Client Components (the instructor's live preview) alike.
 */
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import Markdown, { type Components, type UrlTransform } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { checkComplexity } from '../complexity';
import { classifyUrl } from '../url-policy';
import { strictSanitizeSchema } from './sanitize-schema';

export interface MarkdownViewProps {
  /** Author markdown (course description, lecture description, article body). */
  source: string;
  /** Extra classes on the wrapper `<div>`. */
  className?: string;
  /**
   * Prefix for generated element ids (footnotes), against DOM clobbering and so that two views on
   * one page (course description + article preview) do not share ids. Default `user-content-`.
   */
  idPrefix?: string;
}

export const DEFAULT_ID_PREFIX = 'user-content-';

export const LINK_REL = 'noopener noreferrer nofollow ugc';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Anything that is not a safe http(s)/mailto URL or a generated footnote fragment becomes ''. */
const safeUrlTransform: UrlTransform = (url) => {
  const verdict = classifyUrl(url, { allowFragment: true });
  return verdict.ok ? verdict.href : '';
};

type HeadingProps = ComponentPropsWithoutRef<'h1'> & { node?: unknown };

const headingClass = {
  h3: 'mt-6 mb-3 text-xl font-semibold tracking-tight text-foreground first:mt-0',
  h4: 'mt-5 mb-2 text-lg font-semibold text-foreground first:mt-0',
  h5: 'mt-4 mb-2 text-base font-semibold text-foreground first:mt-0',
  h6: 'mt-4 mb-2 text-sm font-semibold text-muted-foreground first:mt-0',
} as const;

function shiftedHeading(Tag: keyof typeof headingClass) {
  return function Heading({ node: _node, className, ...props }: HeadingProps): ReactNode {
    return <Tag {...props} className={cx(headingClass[Tag], className)} />;
  };
}

const TEXT_ALIGN_CLASS: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/**
 * hast-util-to-jsx-runtime turns GFM column alignment into `style="text-align:..."`. Inline styles
 * are never emitted (strict CSP, no CSS injection surface): map the known values to classes.
 */
function alignClass(style: unknown): string | undefined {
  const align = (style as { textAlign?: unknown } | undefined)?.textAlign;
  return typeof align === 'string' ? TEXT_ALIGN_CLASS[align] : undefined;
}

function createComponents(idPrefix: string): Components {
  return {
    h1: shiftedHeading('h3'),
    h2: shiftedHeading('h4'),
    h3: shiftedHeading('h5'),
    h4: shiftedHeading('h6'),
    h5: shiftedHeading('h6'),
    h6: shiftedHeading('h6'),
    p: ({ node: _node, ...props }) => <p {...props} className="my-3 leading-7 first:mt-0" />,
    a: ({ node: _node, href, children, className, ...props }) => {
      const verdict = href ? classifyUrl(href, { allowFragment: true }) : null;
      if (!verdict?.ok) return <span>{children}</span>;
      // Fragment targets are ids, which rehype-sanitize prefixed with `idPrefix`: follow suit.
      const target =
        verdict.href.startsWith('#') && !verdict.href.startsWith(`#${idPrefix}`)
          ? `#${idPrefix}${verdict.href.slice(1)}`
          : verdict.href;
      return (
        <a
          {...props}
          href={target}
          className={cx(
            'font-medium text-primary underline underline-offset-4 hover:opacity-80',
            className,
          )}
          {...(verdict.href.startsWith('#')
            ? {}
            : verdict.external
              ? { rel: LINK_REL, target: '_blank' }
              : { rel: LINK_REL })}
        >
          {children}
        </a>
      );
    },
    img: () => null,
    ul: ({ node: _node, className, ...props }) => (
      <ul
        {...props}
        className={cx(
          'my-3 ml-6 list-disc space-y-1 [&.contains-task-list]:ml-0 [&.contains-task-list]:list-none',
          className,
        )}
      />
    ),
    ol: ({ node: _node, className, ...props }) => (
      <ol {...props} className={cx('my-3 ml-6 list-decimal space-y-1', className)} />
    ),
    li: ({ node: _node, ...props }) => <li {...props} className="leading-7" />,
    input: ({ checked }) => (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled
        readOnly
        className="mr-2 align-middle"
      />
    ),
    blockquote: ({ node: _node, ...props }) => (
      <blockquote {...props} className="my-4 border-l-4 border-border pl-4 text-muted-foreground" />
    ),
    hr: ({ node: _node, ...props }) => <hr {...props} className="my-6 border-border" />,
    pre: ({ node: _node, ...props }) => (
      <pre
        {...props}
        className="my-4 overflow-x-auto rounded-md bg-muted p-4 text-sm [&>code]:bg-transparent [&>code]:p-0"
      />
    ),
    code: ({ node: _node, className, ...props }) => (
      <code
        {...props}
        className={cx('rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em]', className)}
      />
    ),
    table: ({ node: _node, ...props }) => (
      <div className="my-4 w-full overflow-x-auto">
        <table {...props} className="w-full border-collapse text-sm" />
      </div>
    ),
    th: ({ node: _node, style, ...props }) => (
      <th
        {...props}
        className={cx(
          'border border-border bg-muted px-3 py-2 font-semibold',
          alignClass(style) ?? 'text-left',
        )}
      />
    ),
    td: ({ node: _node, style, ...props }) => (
      <td {...props} className={cx('border border-border px-3 py-2', alignClass(style))} />
    ),
    section: ({ node: _node, ...props }) => (
      <section
        {...props}
        className="mt-8 border-t border-border pt-4 text-sm text-muted-foreground"
      />
    ),
  };
}

const componentsByPrefix = new Map<string, Components>();
function componentsFor(idPrefix: string): Components {
  let components = componentsByPrefix.get(idPrefix);
  if (!components) {
    components = createComponents(idPrefix);
    if (componentsByPrefix.size < 32) componentsByPrefix.set(idPrefix, components);
  }
  return components;
}

type PluggableList = NonNullable<Parameters<typeof Markdown>[0]['rehypePlugins']>;

const remarkPlugins: PluggableList = [remarkGfm];
// remark-rehype must NOT prefix footnote ids itself: rehype-sanitize's clobber prefix does it (once).
const remarkRehypeOptions = { clobberPrefix: '' };

export function MarkdownView({
  source,
  className,
  idPrefix = DEFAULT_ID_PREFIX,
}: MarkdownViewProps): ReactNode {
  const wrapperClass = cx('text-base text-foreground break-words', className);
  // Content that would blow the parser's cost budget (only possible if it skipped validateMarkdown,
  // e.g. seeded data) is shown as escaped plain text instead of stalling the server render.
  if (checkComplexity(source)) {
    return (
      <div className={wrapperClass}>
        <p className="whitespace-pre-wrap">{source}</p>
      </div>
    );
  }
  const rehypePlugins: PluggableList = [
    [rehypeSanitize, { ...strictSanitizeSchema, clobberPrefix: idPrefix }],
  ];
  return (
    <div className={wrapperClass}>
      <Markdown
        remarkPlugins={remarkPlugins}
        remarkRehypeOptions={remarkRehypeOptions}
        rehypePlugins={rehypePlugins}
        skipHtml
        urlTransform={safeUrlTransform}
        components={componentsFor(idPrefix)}
      >
        {source}
      </Markdown>
    </div>
  );
}
