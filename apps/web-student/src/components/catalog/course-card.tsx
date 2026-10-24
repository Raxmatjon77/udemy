import type { CourseCard as CourseCardData, CourseRating, PublicPrice } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import Link from 'next/link';

import { PriceTag, type PriceMap } from '@/components/commerce/price-tag';
import { formatTotalDuration, levelLabel, pluralize } from '@/lib/catalog/format';

import { CourseRatingLine } from './course-rating';
import { CourseThumbnail } from './course-thumbnail';

/**
 * One course in a grid. The whole card is one link (the title's `::after` covers the card), so
 * keyboard users get a single tab stop per course with the title as its accessible name.
 */
export function CourseCard({
  course,
  price,
  rating,
  priority = false,
}: {
  course: CourseCardData;
  /** From `GET /engagement/ratings` (Phase 5): shown when the course has reviews. */
  rating?: CourseRating | null | undefined;
  /**
   * From `GET /commerce/prices`: a price, null when the course has none (not for sale), or
   * undefined when prices could not be loaded (then no price line is shown at all).
   */
  price?: PublicPrice | null | undefined;
  priority?: boolean;
}) {
  const level = levelLabel(course.level);
  return (
    <article
      data-testid="course-card"
      className="group relative flex h-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs transition-shadow focus-within:ring-[3px] focus-within:ring-ring/50 hover:shadow-md"
    >
      <CourseThumbnail
        courseId={course.id}
        title={course.title}
        hasThumbnail={course.hasThumbnail}
        priority={priority}
      />
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
        <CourseRatingLine rating={rating} />
        {price !== undefined ? <PriceTag price={price} className="pt-1" /> : null}
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
  prices,
  priceOf,
  ratings,
  ratingOf,
  priorityCount = 0,
  label,
}: {
  /** The courses' rating summaries (Phase 5); missing = no reviews or not loaded. */
  ratings?: Readonly<Record<string, CourseRating>> | undefined;
  /** Per-course lookup instead of `ratings`. */
  ratingOf?: ((courseId: string) => CourseRating | undefined) | undefined;
  courses: readonly CourseCardData[];
  /** The courses' prices; a course missing from the map has no price. Undefined: not loaded. */
  prices?: PriceMap | undefined;
  /** Per-course lookup instead of `prices` (null: no price, undefined: unknown). */
  priceOf?: ((courseId: string) => PublicPrice | null | undefined) | undefined;
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
          <CourseCard
            course={course}
            price={priceOf ? priceOf(course.id) : prices ? (prices[course.id] ?? null) : undefined}
            rating={ratingOf ? ratingOf(course.id) : ratings?.[course.id]}
            priority={index < priorityCount}
          />
        </li>
      ))}
    </ul>
  );
}
