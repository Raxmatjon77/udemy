'use client';

import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';

import { QueryError } from './query-error';

/** The subset of a TanStack `useInfiniteQuery` result the footer needs. */
export interface LoadMoreQuery {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  error: unknown;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * Keyset "load more" footer under a list: a polite count, the button while there is a next
 * cursor, and the error of a failed next page (the rows already loaded stay visible).
 */
export function LoadMore({
  query,
  count,
  noun,
}: {
  query: LoadMoreQuery;
  count: number;
  noun: readonly [singular: string, plural: string];
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Showing {count} {count === 1 ? noun[0] : noun[1]}
          {query.hasNextPage ? '' : ' (all)'}
        </p>
        {query.hasNextPage ? (
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? <Spinner /> : null}
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>
      {query.isFetchNextPageError ? (
        <QueryError error={query.error} onRetry={() => void query.fetchNextPage()} />
      ) : null}
    </>
  );
}
