import type { Metadata } from 'next';
import { InstructorQaStatusSchema, UuidSchema } from '@udemy/contracts';

import { QaInbox } from './qa-inbox';

export const metadata: Metadata = { title: 'Q&A' };

/** `/qa?courseId=&status=` (links from the bell); invalid values fall back to the defaults. */
export default async function QaPage({
  searchParams,
}: {
  searchParams: Promise<{ courseId?: string | string[]; status?: string | string[] }>;
}) {
  const { courseId, status } = await searchParams;
  const course = UuidSchema.safeParse(courseId);
  const parsedStatus = InstructorQaStatusSchema.safeParse(status);
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-10">
      <QaInbox
        initialCourseId={course.success ? course.data : undefined}
        initialStatus={parsedStatus.success ? parsedStatus.data : 'unanswered'}
      />
    </main>
  );
}
