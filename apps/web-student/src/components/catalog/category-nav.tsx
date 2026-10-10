import type { CategoryLeaf } from '@udemy/contracts';
import { cn } from '@udemy/ui/lib/utils';
import Link from 'next/link';

import { categoryHref } from '@/lib/catalog/categories';

/** A row of category links ("chips"); the current one is marked with `aria-current`. */
export function CategoryChips({
  label,
  items,
  currentSlug,
}: {
  label: string;
  items: readonly CategoryLeaf[];
  currentSlug?: string;
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => {
          const current = item.slug === currentSlug;
          return (
            <li key={item.id}>
              <Link
                href={categoryHref(item.slug)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-flex h-8 items-center rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  current
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {item.name}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

/** Breadcrumb trail; the last crumb is the current page (no link). */
export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${index}-${item.label}`} className="flex items-center gap-1.5">
              {item.href && !last ? (
                <Link
                  href={item.href}
                  className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={last ? 'text-foreground' : undefined}
                >
                  {item.label}
                </span>
              )}
              {last ? null : <span aria-hidden="true">›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
