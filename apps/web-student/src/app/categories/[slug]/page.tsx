import { BROWSE_COURSES_PAGE_LIMIT_DEFAULT } from '@udemy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { BrowseView } from '@/components/catalog/browse-view';
import { CatalogUnavailable } from '@/components/catalog/catalog-states';
import { Breadcrumbs, CategoryChips } from '@/components/catalog/category-nav';
import { parseBrowseFilters, type BrowseFilters } from '@/lib/catalog/browse-params';
import { categoryHref, findCategory } from '@/lib/catalog/categories';
import { browseCourses, getCategoryTree, isPlausibleSlug, settle } from '@/lib/catalog/server';

/**
 * `/categories/{slug}`: a depth-1 group (its courses include every child's) or a depth-2 leaf,
 * with a breadcrumb, sibling/child chips, and the filtered browse (level, language, search).
 */
export async function generateMetadata({
  params,
}: PageProps<'/categories/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const tree = isPlausibleSlug(slug) ? await settle(getCategoryTree()) : null;
  const match = tree?.ok ? findCategory(tree.data, slug) : null;
  if (!match) return { title: 'Category' };
  const name = (match.leaf ?? match.group).name;
  return {
    title: `${name} courses`,
    description: `Browse published ${name} courses.`,
    alternates: { canonical: categoryHref(slug) },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: PageProps<'/categories/[slug]'>) {
  const { slug } = await params;
  if (!isPlausibleSlug(slug)) notFound();

  const tree = await settle(getCategoryTree());
  if (!tree.ok) {
    return (
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6">
        <CatalogUnavailable retryHref={categoryHref(slug)} />
      </main>
    );
  }
  const match = findCategory(tree.data, slug);
  if (!match) notFound();

  const { filters: parsed, ignored } = parseBrowseFilters(await searchParams);
  // The category is the path: a `?category=` in the URL is ignored here.
  const urlFilters: BrowseFilters = { ...parsed };
  delete urlFilters.category;
  const apiFilters: BrowseFilters = { ...urlFilters, category: slug };
  const limit = BROWSE_COURSES_PAGE_LIMIT_DEFAULT;
  const page = await settle(browseCourses(apiFilters, { limit }));

  const { group, leaf } = match;
  const current = leaf ?? group;
  const chips =
    group.children.length > 0
      ? [{ id: group.id, slug: group.slug, name: `All ${group.name}` }, ...group.children]
      : [];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <Breadcrumbs
          items={[
            { label: 'Courses', href: '/courses' },
            { label: group.name, href: categoryHref(group.slug) },
            ...(leaf ? [{ label: leaf.name }] : []),
          ]}
        />
        <h1 className="text-3xl font-bold tracking-tight">{current.name} courses</h1>
      </header>
      {chips.length > 0 ? (
        <CategoryChips
          label={`${group.name} subcategories`}
          items={chips}
          currentSlug={current.slug}
        />
      ) : null}
      <BrowseView
        basePath={categoryHref(slug)}
        urlFilters={urlFilters}
        apiFilters={apiFilters}
        result={page}
        limit={limit}
        ignored={ignored.filter((key) => key !== 'category')}
      />
    </main>
  );
}
