import type { CourseCard as CourseCardData } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import Link from 'next/link';

import { formatTotalDuration, levelLabel, pluralize } from '@/lib/catalog/format';

import { CourseThumbnail } from './course-thumbnail';

/**
 * One course in a grid. The whole card is one link (the title's `::after` covers the card), so
 * keyboard users get a single tab stop per course with the title as its accessible name.
 */
export function CourseCard({
  course,
  priority = false,
}: {
  course: CourseCardData;
  priority?: boolean;
}) {
  const level = levelLabel(course.level);
  return (
    <article
      data-testid="course-card"
      className="group relative flex h-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs transition-shadow focus-within:ring-[3px] focus-within:ring-ring/50 hover:shadow-md"
    >
      <CourseThumbnail courseId={course.id} title={course.title} priority={priority} />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 leading-snug font-semibold">
          <Link
            href={`/course/${encodeURIComponent(course.slug)}`}
            className="outline-none after:absolute after:inset-0 after:content-['']"
          >
            {course.title}
          </Link>
        </h3>
        {course.subtitle ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{course.subtitle}</p>
        ) : null}
        {course.instructor ? (
          <p className="text-xs text-muted-foreground">{course.instructor.displayName}</p>
        ) : null}
        <p className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-xs text-muted-foreground">
          <span>{pluralize(course.lectureCount, 'lecture')}</span>
          {course.videoSeconds > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatTotalDuration(course.videoSeconds)} of video</span>
            </>
          ) : null}
          {level ? (
            <Badge variant="outline" className="ml-auto">
              {level}
            </Badge>
          ) : null}
        </p>
      </div>
    </article>
  );
}

export function CourseGrid({
  courses,
  priorityCount = 0,
  label,
}: {
  courses: readonly CourseCardData[];
  /** Eagerly load the first N thumbnails (above the fold). */
  priorityCount?: number;
  label?: string;
}) {
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {courses.map((course, index) => (
        <li key={course.id}>
          <CourseCard course={course} priority={index < priorityCount} />
        </li>
      ))}
    </ul>
  );
}
