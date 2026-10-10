import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UuidSchema } from '@udemy/contracts';

import { BUILDER_TABS, type BuilderTab } from './_components/builder-tabs';
import { CourseBuilder } from './_components/course-builder';

export const metadata: Metadata = { title: 'Course builder' };

export default async function CourseBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { courseId } = await params;
  if (!UuidSchema.safeParse(courseId).success) notFound();
  const { tab } = await searchParams;
  const initialTab = BUILDER_TABS.find((value) => value === tab) satisfies BuilderTab | undefined;
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-10">
      <CourseBuilder courseId={courseId} {...(initialTab ? { initialTab } : {})} />
    </main>
  );
}
