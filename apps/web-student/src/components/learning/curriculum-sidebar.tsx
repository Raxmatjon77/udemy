'use client';

import type { PlayerBootstrap, PlayerLecture } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Progress } from '@udemy/ui/components/progress';
import { cn } from '@udemy/ui/lib/utils';
import Link from 'next/link';

import {
  describeDuration,
  formatClock,
  LECTURE_TYPE_LABELS,
  pluralize,
} from '@/lib/catalog/format';
import { lectureHref } from '@/lib/learning/links';

/**
 * The player's left pane (design §10): course progress, then every section with its lectures,
 * completion ticks, durations and quiz badges. Each lecture is a link (`/learn/{c}/{l}`), the
 * current one marked `aria-current="page"`.
 */
export function CurriculumSidebar({
  bootstrap,
  currentLectureId,
}: {
  bootstrap: PlayerBootstrap;
  currentLectureId: string;
}) {
  const { progress } = bootstrap;
  return (
    <nav aria-label="Course content" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border p-4">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium" id="course-progress-label">
            Your progress
          </span>
          <span className="text-muted-foreground" data-testid="course-progress">
            {progress.completed} of {progress.total} complete · {progress.pct}%
          </span>
        </div>
        <Progress value={progress.pct} aria-labelledby="course-progress-label" />
        {bootstrap.newContent ? (
          <Badge variant="secondary" className="mt-1">
            New content
          </Badge>
        ) : null}
      </div>

      <ol className="flex flex-col gap-3">
        {bootstrap.sections.map((section, index) => {
          const done = section.lectures.filter((l) => l.completed).length;
          return (
            <li key={section.id} className="rounded-lg border">
              <div className="flex items-baseline justify-between gap-2 border-b bg-muted/40 px-4 py-2">
                <h3 className="text-sm font-semibold">
                  Section {index + 1}: {section.title}
                </h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {done}/{section.lectures.length}
                </span>
              </div>
              <ol>
                {section.lectures.map((lecture) => (
                  <li key={lecture.id}>
                    <LectureLink
                      courseId={bootstrap.courseId}
                      lecture={lecture}
                      current={lecture.id === currentLectureId}
                    />
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function LectureLink({
  courseId,
  lecture,
  current,
}: {
  courseId: string;
  lecture: PlayerLecture;
  current: boolean;
}) {
  return (
    <Link
      href={lectureHref(courseId, lecture.id)}
      aria-current={current ? 'page' : undefined}
      data-testid="curriculum-lecture"
      data-completed={lecture.completed || undefined}
      className={cn(
        'flex items-start gap-3 px-4 py-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        current && 'bg-accent font-medium',
      )}
    >
      <CompletionMark completed={lecture.completed} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2">{lecture.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{LECTURE_TYPE_LABELS[lecture.type]}</span>
          {lecture.durationSeconds !== null && lecture.durationSeconds > 0 ? (
            <span>
              <span aria-hidden="true">{formatClock(lecture.durationSeconds)}</span>
              <span className="sr-only">{describeDuration(lecture.durationSeconds)}</span>
            </span>
          ) : null}
          {lecture.quiz ? (
            <Badge variant="outline" className="text-[10px]">
              Quiz · {pluralize(lecture.quiz.questionCount, 'question')}
            </Badge>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

function CompletionMark({ completed }: { completed: boolean }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
        completed ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
      )}
    >
      {completed ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
      <span className="sr-only">{completed ? 'Completed:' : 'Not completed:'}</span>
    </span>
  );
}
