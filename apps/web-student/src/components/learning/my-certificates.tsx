'use client';

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { CertificatePage } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import Link from 'next/link';

import { EmptyState } from '@/components/catalog/catalog-states';
import { formatDate } from '@/lib/format';
import { fetchMyCertificates, learningKeys } from '@/lib/learning/client';
import { certificateHref } from '@/lib/learning/links';
import { problemMessage } from '@/lib/problem';

import { CertificatePdfButton } from './certificate-pdf-button';

/** My certificates (design D7): newest first, valid or revoked, with the share link and PDF. */
export function MyCertificates() {
  const query = useInfiniteQuery<
    CertificatePage,
    Error,
    InfiniteData<CertificatePage, string | null>,
    typeof learningKeys.certificates,
    string | null
  >({
    queryKey: learningKeys.certificates,
    queryFn: ({ pageParam, signal }) => fetchMyCertificates(pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });

  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your certificates…
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
      <EmptyState title="No certificates yet">
        Complete every lecture of a course to earn its certificate.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Your certificates" className="flex flex-col gap-3">
        {items.map((certificate) => (
          <li
            key={certificate.id}
            data-testid="my-certificate"
            className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="font-semibold">{certificate.courseTitle}</p>
              <p className="text-xs text-muted-foreground">
                Issued{' '}
                <time dateTime={certificate.issuedAt}>{formatDate(certificate.issuedAt)}</time> ·{' '}
                {certificate.instructorName}
              </p>
            </div>
            {certificate.status === 'REVOKED' ? (
              <Badge variant="destructive">Revoked</Badge>
            ) : (
              <>
                <Button asChild size="sm" variant="ghost">
                  <Link href={certificateHref(certificate.code)}>Share link</Link>
                </Button>
                {certificate.pdfReady ? (
                  <CertificatePdfButton certificateId={certificate.id} variant="outline" />
                ) : (
                  <span className="text-xs text-muted-foreground">PDF in preparation</span>
                )}
              </>
            )}
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
