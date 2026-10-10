import type { Metadata } from 'next';
import { AdminCoursesQuerySchema } from '@udemy/contracts';

import { studentAppOrigin } from '@/lib/env';

import { CoursesSearch, type CourseFilters } from './courses-search';

export const metadata: Metadata = { title: 'Courses' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CoursesPage({ searchParams }: PageProps<'/courses'>) {
  const params = await searchParams;
  const { shape } = AdminCoursesQuerySchema;
  // Each filter is validated on its own: one bad value (e.g. a 2-letter q) does not drop the rest.
  const q = shape.q.safeParse(first(params.q));
  const status = shape.status.safeParse(first(params.status));
  const ownerId = shape.ownerId.safeParse(first(params.ownerId));
  const filters: CourseFilters = {
    q: q.success ? q.data : undefined,
    status: status.success ? status.data : undefined,
    ownerId: ownerId.success ? ownerId.data : undefined,
  };

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Courses</h1>
        <p className="text-sm text-muted-foreground">
          Every course, most recently updated first. Take a live course down when it breaks the
          rules, for example when its instructor is banned.
        </p>
      </div>
      <CoursesSearch
        key={JSON.stringify(filters)}
        filters={filters}
        studentOrigin={studentAppOrigin()}
      />
    </>
  );
}
