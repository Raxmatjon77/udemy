import type { CourseRating } from '@udemy/contracts';
import { StarRating } from '@udemy/ui/components/star-rating';
import { cn } from '@udemy/ui/lib/utils';

/** "4.6 ★★★★½ (40)" on cards and the landing header; nothing for a course without reviews. */
export function CourseRatingLine({
  rating,
  className,
  long = false,
}: {
  rating: CourseRating | null | undefined;
  className?: string;
  /** "(40 ratings)" instead of "(40)". */
  long?: boolean;
}) {
  if (!rating || rating.average === null) return null;
  const count = long
    ? `${rating.count} rating${rating.count === 1 ? '' : 's'}`
    : String(rating.count);
  return (
    <p data-testid="course-rating" className={cn('flex items-center gap-1.5 text-xs', className)}>
      <span className="font-semibold text-amber-700 dark:text-amber-400">{rating.average}</span>
      <StarRating value={Number(rating.average)} starClassName="size-3.5" />
      <span className="text-muted-foreground">
        ({count}
        <span className="sr-only">{long ? '' : ' ratings'}</span>)
      </span>
    </p>
  );
}
