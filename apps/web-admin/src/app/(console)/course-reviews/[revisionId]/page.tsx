import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { UuidSchema } from '@udemy/contracts';

import { getSession } from '@/lib/auth/session';

import { RevisionReview } from './revision-review';

export const metadata: Metadata = { title: 'Review course' };

export default async function CourseReviewPage({
  params,
}: PageProps<'/course-reviews/[revisionId]'>) {
  const [{ revisionId }, session] = await Promise.all([params, getSession()]);
  if (!UuidSchema.safeParse(revisionId).success) notFound();

  return (
    <>
      <Link
        href="/course-reviews"
        className="w-fit text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to course reviews
      </Link>
      <RevisionReview revisionId={revisionId} currentUserId={session?.userId ?? null} />
    </>
  );
}
