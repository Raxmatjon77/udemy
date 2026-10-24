import { Button } from '@udemy/ui/components/button';
import Link from 'next/link';

import { CatalogUnavailable, EmptyState } from '@/components/catalog/catalog-states';
import { CourseGrid } from '@/components/catalog/course-card';
import { getSession } from '@/lib/auth/session';
import { categoryHref } from '@/lib/catalog/categories';
import { browseCourses, getCategoryTree, settle } from '@/lib/catalog/server';
import { pricesForPage } from '@/lib/commerce/server';
import { ratingsForPage } from '@/lib/engagement/server';

/** How many of the newest courses the home page shows (two rows on wide screens). */
const NEWEST_COUNT = 8;

/**
 * Home: hero, the newest published courses (the browse order is newest first) and the category
 * groups as entry points. Each catalog section degrades on its own when the API is down.
 */
export default async function HomePage() {
  const [session, newest, tree] = await Promise.all([
    getSession(),
    settle(browseCourses({}, { limit: NEWEST_COUNT })),
    settle(getCategoryTree()),
  ]);
  const [prices, ratings] = await Promise.all([pricesForPage(newest), ratingsForPage(newest)]);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-14 px-4 py-12 sm:px-6">
      <section aria-labelledby="hero-title" className="flex flex-col gap-6">
        <h1 id="hero-title" className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Learn without limits
        </h1>
        <p className="max-w-2xl text-lg text-pretty text-muted-foreground">
          Discover courses taught by real instructors and learn at your own pace.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/courses">Browse courses</Link>
          </Button>
          {session ? (
            !session.roles.includes('INSTRUCTOR') ? (
              <Button asChild size="lg" variant="outline">
                <Link href="/become-instructor">Become an instructor</Link>
              </Button>
            ) : null
          ) : (
            <Button asChild size="lg" variant="outline">
              <Link href="/signup">Join for free</Link>
            </Button>
          )}
        </div>
      </section>

      <section aria-labelledby="newest-title" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="newest-title" className="text-2xl font-semibold tracking-tight">
            New on Udemy
          </h2>
          <Link
            href="/courses"
            className="rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            See all courses
          </Link>
        </div>
        {!newest.ok ? (
          <CatalogUnavailable retryHref="/" />
        ) : newest.data.items.length === 0 ? (
          <EmptyState title="No courses yet">
            The first published courses will show up here.
          </EmptyState>
        ) : (
          <CourseGrid
            courses={newest.data.items}
            prices={prices}
            ratings={ratings}
            priorityCount={4}
            label="Newest courses"
          />
        )}
      </section>

      {tree.ok && tree.data.length > 0 ? (
        <section aria-labelledby="categories-title" className="flex flex-col gap-6">
          <h2 id="categories-title" className="text-2xl font-semibold tracking-tight">
            Browse by category
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tree.data.map((group) => (
              <li key={group.id} className="flex flex-col gap-3 rounded-lg border bg-card p-5">
                <h3 className="font-semibold">
                  <Link
                    href={categoryHref(group.slug)}
                    className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {group.name}
                  </Link>
                </h3>
                {group.children.length > 0 ? (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {group.children.map((leaf) => (
                      <li key={leaf.id}>
                        <Link
                          href={categoryHref(leaf.slug)}
                          className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          {leaf.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
