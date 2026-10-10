'use client';

import type { CourseReadinessIssue, Curriculum } from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';

import { describeReadinessIssue, type BuilderTarget } from '@/lib/labels';

/**
 * The submission checklist (design §4 invariant 6): every unmet requirement, each linking to
 * the field, section or lecture where it is fixed.
 */
export function ReadinessPanel({
  issues,
  curriculum,
  onNavigate,
}: {
  issues: CourseReadinessIssue[];
  curriculum: Curriculum | undefined;
  onNavigate: (target: BuilderTarget) => void;
}) {
  if (issues.length === 0) {
    return (
      <Alert variant="success">
        <AlertTitle>Ready for review</AlertTitle>
        <AlertDescription>Every requirement for submitting the course is met.</AlertDescription>
      </Alert>
    );
  }
  const sections = new Map(curriculum?.sections.map((s) => [s.id, s.title]));
  const lectures = new Map(
    curriculum?.sections.flatMap((s) => s.lectures.map((l) => [l.id, l.title] as const)),
  );
  return (
    <section aria-labelledby="readiness-heading" className="grid gap-3">
      <h3 id="readiness-heading" className="text-base font-semibold">
        Before you can submit ({issues.length} {issues.length === 1 ? 'item' : 'items'} left)
      </h3>
      <ul className="grid gap-2">
        {issues.map((issue, index) => {
          const { message, target } = describeReadinessIssue(issue, {
            section: (id) => sections.get(id),
            lecture: (id) => lectures.get(id),
          });
          return (
            <li
              key={`${issue.code}-${issue.sectionId ?? ''}-${issue.lectureId ?? ''}-${index}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <span>{message}</span>
              <button
                type="button"
                onClick={() => onNavigate(target)}
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {target.tab === 'details' ? 'Go to details' : 'Go to curriculum'}
                <span className="sr-only">: {message}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
