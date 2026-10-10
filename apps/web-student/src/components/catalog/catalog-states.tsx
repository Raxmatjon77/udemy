import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** "The catalog could not be loaded" (API down or answering garbage); the page still renders. */
export function CatalogUnavailable({
  retryHref,
  title = 'The catalog is temporarily unavailable',
}: {
  retryHref: string;
  title?: string;
}) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>We could not load courses right now. Please try again in a moment.</p>
        <Button asChild variant="outline" size="sm" className="mt-2">
          <Link href={retryHref}>Try again</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action}
    </div>
  );
}
