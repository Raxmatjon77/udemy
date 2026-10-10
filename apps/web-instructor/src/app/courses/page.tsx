import type { Metadata } from 'next';

import { MyCourses } from './my-courses';

export const metadata: Metadata = { title: 'My courses' };

export default function MyCoursesPage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-10">
      <MyCourses />
    </main>
  );
}
