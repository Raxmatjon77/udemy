'use client';

import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { problemMessage } from '@/lib/problem';
import { useMe } from '@/lib/queries';

export function Welcome() {
  const me = useMe();

  if (me.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading your account" className="grid gap-3">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (me.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {problemMessage(me.error)}
          <Button size="sm" variant="outline" onClick={() => void me.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const user = me.data;
  return (
    <section aria-labelledby="welcome-title" className="grid gap-6">
      <h1 id="welcome-title" className="text-3xl font-bold tracking-tight">
        Welcome back, {user.displayName}
      </h1>
      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2>Your account</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="font-medium">Email</dt>
            <dd className="flex flex-wrap items-center gap-2 text-muted-foreground">
              {user.email}
              {user.emailVerified ? (
                <Badge variant="outline">Verified</Badge>
              ) : (
                <Badge variant="destructive">Not verified</Badge>
              )}
            </dd>
            <dt className="font-medium">Roles</dt>
            <dd className="flex flex-wrap gap-2">
              {user.roles.map((role) => (
                <Badge key={role} variant="secondary">
                  {role.charAt(0) + role.slice(1).toLowerCase()}
                </Badge>
              ))}
            </dd>
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}
