import { UuidSchema } from '@udemy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CoursePlayer } from '@/components/learning/course-player';

export const metadata: Metadata = { title: 'Learn', robots: { index: false } };

/** `?t=` (whole seconds ≥ 0), or null. */
function startAtOf(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}

/**
 * `/learn/{courseId}[/{lectureId}][?t=seconds]` (session required; learning experience design
 * §10): the course player. Ids that are not UUIDs are a 404 without calling the API; access
 * (ACTIVE enrollment, or the owner's PREVIEW) is decided by the API in the player bootstrap.
 */
export default async function LearnPage({
  params,
  searchParams,
}: PageProps<'/learn/[courseId]/[[...lectureId]]'>) {
  const { courseId, lectureId } = await params;
  const lecture = lectureId?.[0] ?? null;
  if (
    !UuidSchema.safeParse(courseId).success ||
    (lectureId !== undefined && lectureId.length > 1) ||
    (lecture !== null && !UuidSchema.safeParse(lecture).success)
  ) {
    notFound();
  }
  const { t } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
      <CoursePlayer courseId={courseId} lectureId={lecture} startAt={startAtOf(t)} />
    </main>
  );
}
