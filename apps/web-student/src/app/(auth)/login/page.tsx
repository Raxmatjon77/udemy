import type { Metadata } from 'next';
import Link from 'next/link';
import { safeNextPath } from '@udemy/web-auth/safe-next';

import { AuthCard } from '@/components/auth-card';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { next } = await searchParams;
  // Only same-site relative paths survive (no open redirects, design §9).
  const nextPath = safeNextPath(typeof next === 'string' ? next : undefined, '/');

  return (
    <AuthCard
      title="Log in to your account"
      description="Welcome back. Pick up where you left off."
      footer={
        <p>
          New to Udemy?{' '}
          <Link
            href="/signup"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </p>
      }
    >
      <LoginForm next={nextPath} />
    </AuthCard>
  );
}
