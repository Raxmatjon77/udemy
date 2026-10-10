import type { Metadata } from 'next';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { safeNextPath } from '@udemy/web-auth/safe-next';

import { AuthCard } from '@/components/auth-card';
import { LogoutButton } from '@/components/logout-button';
import { getSession } from '@/lib/auth/session';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const [{ next, error }, session] = await Promise.all([searchParams, getSession()]);
  // Only same-site relative paths survive (no open redirects, design §9).
  const nextPath = safeNextPath(typeof next === 'string' ? next : undefined, '/');
  // proxy.ts sends signed-in users without the ADMIN role here with ?error=forbidden.
  const forbidden = error === 'forbidden';

  return (
    <AuthCard title="Admin sign in" description="Restricted to Udemy administrators.">
      <div className="grid gap-5">
        {forbidden ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Administrator access required</AlertTitle>
            <AlertDescription>
              <p>The account you are signed in with is not an administrator.</p>
              {session ? <LogoutButton variant="outline" size="sm" redirectTo="/login" /> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <LoginForm next={nextPath} />
      </div>
    </AuthCard>
  );
}
