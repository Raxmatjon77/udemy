import { BROWSE_COURSES_PAGE_LIMIT_DEFAULT } from '@udemy/contracts';
import type { Metadata } from 'next';

import { BrowseView } from '@/components/catalog/browse-view';
import { CategoryChips } from '@/components/catalog/category-nav';
import { parseBrowseFilters } from '@/lib/catalog/browse-params';
import { browseCourses, getCategoryTree, settle } from '@/lib/catalog/server';
import { pricesForPage } from '@/lib/commerce/server';
import { ratingsForPage } from '@/lib/engagement/server';

export const metadata: Metadata = {
  title: 'Browse courses',
  description: 'Browse published courses by category, level and language.',
  alternates: { canonical: '/courses' },
};

/** `/courses?category=&level=&language=&q=`: the whole catalog with filters (design §10). */
export default async function CoursesPage({ searchParams }: PageProps<'/courses'>) {
  const { filters, ignored } = parseBrowseFilters(await searchParams);
  const limit = BROWSE_COURSES_PAGE_LIMIT_DEFAULT;
  const [tree, page] = await Promise.all([
    settle(getCategoryTree()),
    settle(browseCourses(filters, { limit })),
  ]);
  const [prices, ratings] = await Promise.all([pricesForPage(page), ratingsForPage(page)]);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Browse courses</h1>
        <p className="text-muted-foreground">
          Find your next course by category, level or language.
        </p>
      </header>
      {tree.ok && tree.data.length > 0 ? (
        <CategoryChips label="Categories" items={tree.data} />
      ) : null}
      <BrowseView
        basePath="/courses"
        urlFilters={filters}
        apiFilters={filters}
        categories={tree.ok ? tree.data : undefined}
        result={page}
        prices={prices}
        ratings={ratings}
        limit={limit}
        ignored={ignored}
      />
    </main>
  );
}
