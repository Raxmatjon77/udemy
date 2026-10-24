'use client';

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { AnnouncementPage } from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Button } from '@udemy/ui/components/button';

import { formatDate } from '@/lib/format';
import { fetchAnnouncements, learningKeys } from '@/lib/learning/client';
import { problemMessage } from '@/lib/problem';

/** The course's announcements, newest first, keyset "Load more" (design D18, §10). */
export function AnnouncementsPanel({ courseId }: { courseId: string }) {
  const query = useInfiniteQuery<
    AnnouncementPage,
    Error,
    InfiniteData<AnnouncementPage, string | null>,
    ReturnType<typeof learningKeys.announcements>,
    string | null
  >({
    queryKey: learningKeys.announcements(courseId),
    queryFn: ({ pageParam, signal }) => fetchAnnouncements(courseId, pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });

  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading announcements…
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
    return <p className="text-sm text-muted-foreground">No announcements yet.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Announcements" className="flex flex-col gap-4">
        {items.map((announcement) => (
          <li key={announcement.id} data-testid="announcement" className="rounded-md border p-4">
            <article aria-labelledby={`ann-${announcement.id}`} className="flex flex-col gap-2">
              <h3 id={`ann-${announcement.id}`} className="font-semibold">
                {announcement.title}
              </h3>
              <p className="text-xs text-muted-foreground">
                {announcement.author?.displayName ?? 'The instructor'} ·{' '}
                <time dateTime={announcement.createdAt}>{formatDate(announcement.createdAt)}</time>
              </p>
              <MarkdownView source={announcement.bodyMd} idPrefix={`ann-${announcement.id}-`} />
            </article>
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
          Load more announcements
        </Button>
      ) : null}
    </div>
  );
}
