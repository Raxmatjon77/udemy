'use client';

import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';

// Error boundaries must be Client Components. Error reporting (OpenTelemetry/Sentry) comes in Phase 7.
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card role="alert" className="w-full max-w-md">
        <CardHeader>
          <CardTitle asChild>
            <h1>Something went wrong</h1>
          </CardTitle>
          <CardDescription>An unexpected error occurred while loading this page.</CardDescription>
        </CardHeader>
        {error.digest ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Reference: <code className="font-mono">{error.digest}</code>
            </p>
          </CardContent>
        ) : null}
        <CardFooter>
          <Button onClick={() => retry()}>Try again</Button>
        </CardFooter>
      </Card>
    </main>
  );
}
