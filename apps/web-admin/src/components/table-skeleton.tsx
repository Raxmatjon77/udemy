import { Card, CardContent } from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';

/** Placeholder rows while the first page of a list loads. */
export function TableSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <Card aria-busy="true" aria-label={label}>
      <CardContent className="grid gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
