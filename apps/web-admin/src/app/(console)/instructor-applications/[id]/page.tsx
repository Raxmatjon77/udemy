import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { UuidSchema } from '@udemy/contracts';

import { getSession } from '@/lib/auth/session';

import { ApplicationDetail } from './application-detail';

export const metadata: Metadata = { title: 'Review application' };

export default async function ApplicationPage({
  params,
}: PageProps<'/instructor-applications/[id]'>) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  if (!UuidSchema.safeParse(id).success) notFound();

  return (
    <>
      <Link
        href="/instructor-applications"
        className="w-fit text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to applications
      </Link>
      <ApplicationDetail id={id} currentUserId={session?.userId ?? null} />
    </>
  );
}
