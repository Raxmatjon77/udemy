import type { Metadata } from 'next';
import Link from 'next/link';

import { CreateCourseForm } from './create-course-form';

export const metadata: Metadata = { title: 'New course' };

export default function NewCoursePage() {
  return (
    <main className="mx-auto grid w-full max-w-2xl gap-6 px-6 py-10">
      <div className="grid gap-2">
        <Link
          href="/courses"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← My courses
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Create a course</h1>
        <p className="text-muted-foreground">
          Start with a working title and a category. You can change both later in the course
          builder.
        </p>
      </div>
      <CreateCourseForm />
    </main>
  );
}
