import type { Metadata } from 'next';

import { ReviewQueue } from './review-queue';

export const metadata: Metadata = { title: 'Course reviews' };

export default function CourseReviewsPage() {
  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Course reviews</h1>
        <p className="text-sm text-muted-foreground">
          Submissions waiting for a decision, oldest first. New courses and updates to live courses
          are both reviewed before anything changes for students.
        </p>
      </div>
      <ReviewQueue />
    </>
  );
}
