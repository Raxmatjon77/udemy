'use client';

import {
  COURSE_LANGUAGE_LABELS,
  COURSE_LANGUAGES,
  COURSE_LEVEL_LABELS,
  COURSE_LEVELS,
  type CategoryNode,
} from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Input } from '@udemy/ui/components/input';
import { Label } from '@udemy/ui/components/label';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type FormEvent } from 'react';

import {
  filtersToSearch,
  hasActiveFilters,
  isCourseLanguage,
  isCourseLevel,
  SEARCH_MIN_LENGTH,
  type BrowseFilters,
} from '@/lib/catalog/browse-params';

/**
 * The filter bar of `/courses` and `/categories/[slug]`. The URL is the state: every change
 * navigates to `basePath?…` (filters only; the cursor never goes into the URL), and the server
 * page renders the first page for it. Without JavaScript the same `<form method="get">` still
 * works.
 */
export function BrowseFilters({
  basePath,
  filters,
  categories,
}: {
  basePath: string;
  filters: BrowseFilters;
  /**
   * The category tree for the category select. Omitted on a category page, where the category
   * is the path (`basePath`) and `filters` never carries one.
   */
  categories?: readonly CategoryNode[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(filters.q ?? '');
  const [queryError, setQueryError] = useState<string | null>(null);
  const id = useId();

  function navigate(next: BrowseFilters) {
    startTransition(() => {
      router.push(`${basePath}${filtersToSearch(next)}`, { scroll: false });
    });
  }

  function update(key: 'category' | 'level' | 'language', value: string) {
    const next: BrowseFilters = { ...filters };
    if (key === 'level') next.level = isCourseLevel(value) ? value : undefined;
    else if (key === 'language') next.language = isCourseLanguage(value) ? value : undefined;
    else next.category = value || undefined;
    navigate(withQuery(next, filters.q));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = query.trim();
    if (q.length > 0 && q.length < SEARCH_MIN_LENGTH) {
      setQueryError(`Enter at least ${SEARCH_MIN_LENGTH} characters to search.`);
      return;
    }
    setQueryError(null);
    navigate(withQuery(filters, q || undefined));
  }

  const active = hasActiveFilters(filters);

  return (
    <form
      role="search"
      aria-label="Filter courses"
      action={basePath}
      method="get"
      onSubmit={onSubmit}
      aria-busy={pending || undefined}
      className="flex flex-col gap-4 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-q`}>Search</Label>
        <div className="flex gap-2">
          <Input
            id={`${id}-q`}
            name="q"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search course titles"
            maxLength={100}
            autoComplete="off"
            aria-invalid={queryError ? true : undefined}
            aria-describedby={queryError ? `${id}-q-error` : undefined}
          />
          <Button type="submit" disabled={pending}>
            Search
          </Button>
        </div>
        {queryError ? (
          <p id={`${id}-q-error`} role="alert" className="text-sm text-destructive">
            {queryError}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {categories ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-category`}>Category</Label>
            <NativeSelect
              id={`${id}-category`}
              name="category"
              value={filters.category ?? ''}
              onChange={(event) => update('category', event.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((group) => (
                <optgroup key={group.id} label={group.name}>
                  <option value={group.slug}>All {group.name}</option>
                  {group.children.map((leaf) => (
                    <option key={leaf.id} value={leaf.slug}>
                      {leaf.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-level`}>Level</Label>
          <NativeSelect
            id={`${id}-level`}
            name="level"
            value={filters.level ?? ''}
            onChange={(event) => update('level', event.target.value)}
          >
            <option value="">Any level</option>
            {COURSE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {COURSE_LEVEL_LABELS[level]}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-language`}>Language</Label>
          <NativeSelect
            id={`${id}-language`}
            name="language"
            value={filters.language ?? ''}
            onChange={(event) => update('language', event.target.value)}
          >
            <option value="">Any language</option>
            {COURSE_LANGUAGES.map((language) => (
              <option key={language} value={language} lang={language}>
                {COURSE_LANGUAGE_LABELS[language]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {active ? (
        <div>
          <Button
            type="button"
            variant="link"
            className="h-auto px-0"
            onClick={() => {
              setQuery('');
              setQueryError(null);
              navigate({});
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function withQuery(filters: BrowseFilters, q: string | undefined): BrowseFilters {
  const next = { ...filters };
  if (q) next.q = q;
  else delete next.q;
  return next;
}
