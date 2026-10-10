import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { UuidSchema } from '@udemy/contracts';

import { getSession } from '@/lib/auth/session';

import { UserDetail } from './user-detail';

export const metadata: Metadata = { title: 'User' };

export default async function UserPage({ params }: PageProps<'/users/[id]'>) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  if (!UuidSchema.safeParse(id).success) notFound();

  return (
    <>
      <Link
        href="/users"
        className="w-fit text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to users
      </Link>
      <UserDetail id={id} currentUserId={session?.userId ?? null} />
    </>
  );
}
