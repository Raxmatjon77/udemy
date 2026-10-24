'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { WishlistPage } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import Link from 'next/link';

import { EmptyState } from '@/components/catalog/catalog-states';
import { CourseThumbnail } from '@/components/catalog/course-thumbnail';
import { courseHref } from '@/lib/commerce/links';
import { engagementKeys, fetchWishlist, removeFromWishlist } from '@/lib/engagement/client';
import { problemMessage } from '@/lib/problem';

/** My wishlist (design D19): newest first, keyset "Load more", remove. */
export function MyWishlist() {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery<
    WishlistPage,
    Error,
    InfiniteData<WishlistPage, string | null>,
    typeof engagementKeys.wishlist,
    string | null
  >({
    queryKey: engagementKeys.wishlist,
    queryFn: ({ pageParam, signal }) => fetchWishlist(pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const remove = useMutation({
    mutationFn: removeFromWishlist,
    onSettled: () => queryClient.invalidateQueries({ queryKey: engagementKeys.wishlistAll }),
  });

  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your wishlist…
      </p>
    );
  }
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {problemMessage(query.error)}
      </p>
    );
  }
  const items = query.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <EmptyState
        title="Your wishlist is empty"
        action={
          <Button asChild variant="outline">
            <Link href="/courses">Browse courses</Link>
          </Button>
        }
      >
        Save courses you are interested in with the heart on their page.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Wishlist" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <li
            key={item.courseId}
            data-testid="wishlist-item"
            className="flex flex-col overflow-hidden rounded-lg border"
          >
            <CourseThumbnail
              courseId={item.courseId}
              title={item.title}
              hasThumbnail={item.hasThumbnail}
            />
            <div className="flex flex-1 flex-col gap-2 p-4">
              <h3 className="font-semibold">
                {item.available ? (
                  <Link href={courseHref(item.slug)} className="hover:underline">
                    {item.title}
                  </Link>
                ) : (
                  item.title
                )}
              </h3>
              {item.instructor ? (
                <p className="text-xs text-muted-foreground">{item.instructor.displayName}</p>
              ) : null}
              <div className="mt-auto flex items-center gap-2 pt-2">
                {!item.available ? <Badge variant="secondary">No longer available</Badge> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(item.courseId)}
                  aria-label={`Remove ${item.title} from your wishlist`}
                >
                  Remove
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
