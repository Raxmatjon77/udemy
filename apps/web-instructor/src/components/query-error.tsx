'use client';

import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';

import { problemMessage } from '@/lib/problem';

/** A failed query, with a retry button. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {problemMessage(error)}
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
