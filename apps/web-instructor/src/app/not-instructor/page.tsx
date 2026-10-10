import type { Metadata } from 'next';
import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';

import { LogoutButton } from '@/components/logout-button';
import { becomeInstructorUrl } from '@/lib/student-app';

export const metadata: Metadata = { title: 'Instructor access required' };

/**
 * proxy.ts sends signed-in users without the INSTRUCTOR role here (e.g. the role was revoked
 * after they logged in). This page itself is never role-gated, so it cannot loop.
 */
export default function NotInstructorPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle asChild>
            <h1 className="text-2xl tracking-tight">Instructor access required</h1>
          </CardTitle>
          <CardDescription>
            Your account does not have the instructor role, so the instructor tools are not
            available to you.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Apply on Udemy to become an instructor. Once an administrator approves your application,
          log in here again.
        </CardContent>
        <CardFooter className="flex flex-wrap gap-3">
          <Button asChild>
            <a href={becomeInstructorUrl()}>Apply to become an instructor</a>
          </Button>
          <LogoutButton variant="outline">Log out</LogoutButton>
        </CardFooter>
      </Card>
    </main>
  );
}
