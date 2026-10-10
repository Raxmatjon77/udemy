import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthCard } from '@/components/auth-card';

import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Sign up' };

export default function SignupPage() {
  return (
    <AuthCard
      title="Create your account"
      description="Join for free and start learning today."
      footer={
        <p>
          Already have an account?{' '}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Log in
          </Link>
        </p>
      }
    >
      <SignupForm />
    </AuthCard>
  );
}
