import type { CategoryNode, CourseCardPage } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import Link from 'next/link';

import {
  filtersToSearch,
  hasActiveFilters,
  type BrowseFilterKey,
  type BrowseFilters as Filters,
} from '@/lib/catalog/browse-params';
import type { Loaded } from '@/lib/catalog/server';

import { BrowseFilters } from './browse-filters';
import { BrowseResults } from './browse-results';
import { CatalogUnavailable, EmptyState } from './catalog-states';

const IGNORED_LABELS: Record<BrowseFilterKey, string> = {
  category: 'category',
  level: 'level',
  language: 'language',
  q: 'search (at least 3 characters)',
};

/**
 * Filter bar + results of a browse page. Server component: the first page arrives rendered;
 * `BrowseResults` takes over for "Load more".
 */
export function BrowseView({
  basePath,
  urlFilters,
  apiFilters,
  categories,
  result,
  limit,
  ignored = [],
}: {
  /** The page path the filters navigate to (`/courses`, `/categories/{slug}`). */
  basePath: string;
  /** The filters in this page's URL. */
  urlFilters: Filters;
  /** The filters sent to the API (`urlFilters` plus a category page's category). */
  apiFilters: Filters;
  /** Shown as a category select when given (the all-courses page). */
  categories?: readonly CategoryNode[] | undefined;
  result: Loaded<CourseCardPage>;
  limit: number;
  /** URL filters dropped as invalid, to tell the user. */
  ignored?: readonly BrowseFilterKey[];
}) {
  const currentHref = `${basePath}${filtersToSearch(urlFilters)}`;
  return (
    <div className="flex flex-col gap-6">
      <BrowseFilters
        key={currentHref}
        basePath={basePath}
        filters={urlFilters}
        {...(categories ? { categories } : {})}
      />

      {ignored.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Ignored an invalid {ignored.map((key) => IGNORED_LABELS[key]).join(', ')} filter.
        </p>
      ) : null}

      {!result.ok ? (
        <CatalogUnavailable retryHref={currentHref} />
      ) : result.data.items.length === 0 ? (
        <EmptyState
          title={hasActiveFilters(urlFilters) ? 'No courses match these filters' : 'No courses yet'}
          action={
            hasActiveFilters(urlFilters) ? (
              <Button asChild variant="outline">
                <Link href={basePath}>Clear filters</Link>
              </Button>
            ) : null
          }
        >
          {hasActiveFilters(urlFilters)
            ? 'Try another level or language, or a shorter search.'
            : 'Published courses will show up here.'}
        </EmptyState>
      ) : (
        <BrowseResults
          key={JSON.stringify(apiFilters)}
          filters={apiFilters}
          initialPage={result.data}
          limit={limit}
        />
      )}
    </div>
  );
}
