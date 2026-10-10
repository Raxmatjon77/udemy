import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AdminInstructorApplicationsQuerySchema,
  INSTRUCTOR_APPLICATION_STATUSES,
} from '@udemy/contracts';
import { cn } from '@udemy/ui/lib/utils';

import { APPLICATION_STATUS_LABEL } from '@/lib/labels';

import { ApplicationsQueue } from './applications-queue';

export const metadata: Metadata = { title: 'Instructor applications' };

export default async function InstructorApplicationsPage({
  searchParams,
}: PageProps<'/instructor-applications'>) {
  const { status: raw } = await searchParams;
  const parsed = AdminInstructorApplicationsQuerySchema.shape.status.safeParse(
    typeof raw === 'string' ? raw : undefined,
  );
  const status = parsed.success ? parsed.data : 'PENDING';

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Instructor applications</h1>
        <p className="text-sm text-muted-foreground">
          Review who wants to teach. Oldest applications first.
        </p>
      </div>
      <nav aria-label="Filter by status">
        <ul className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
          {INSTRUCTOR_APPLICATION_STATUSES.map((value) => {
            const active = value === status;
            return (
              <li key={value}>
                <Link
                  href={`/instructor-applications?status=${value}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'block rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {APPLICATION_STATUS_LABEL[value]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <ApplicationsQueue key={status} status={status} />
    </>
  );
}
