import type { Metadata } from 'next';
import { safeNextPath } from '@udemy/web-auth/safe-next';

import { AuthCard } from '@/components/auth-card';
import { becomeInstructorUrl } from '@/lib/student-app';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { next } = await searchParams;
  // Only same-site relative paths survive (no open redirects, design §9).
  const nextPath = safeNextPath(typeof next === 'string' ? next : undefined, '/');

  return (
    <AuthCard
      title="Instructor sign in"
      description="Log in with your Udemy account to manage your courses."
      footer={
        <p>
          Not an instructor yet?{' '}
          <a
            href={becomeInstructorUrl()}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Apply to teach
          </a>
        </p>
      }
    >
      <LoginForm next={nextPath} becomeInstructorUrl={becomeInstructorUrl()} />
    </AuthCard>
  );
}
