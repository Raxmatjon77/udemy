import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';
import { StarRating } from './star-rating';

/*
 * Rating summary (Phase 5 design §10): the average, its stars, the review count and a
 * histogram (5 → 1). With `onSelectRating` each histogram row is a toggle button that filters
 * a review list (`aria-pressed`).
 */

export type RatingHistogramCounts = Readonly<Record<'1' | '2' | '3' | '4' | '5', number>>;

const ROWS = [5, 4, 3, 2, 1] as const;

function RatingSummary({
  average,
  count,
  histogram,
  selectedRating = null,
  onSelectRating,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  /** Decimal string with one place (`'4.6'`), or null without reviews. */
  average: string | null;
  count: number;
  histogram: RatingHistogramCounts;
  selectedRating?: number | null;
  onSelectRating?: (rating: number | null) => void;
}) {
  const value = average === null ? null : Number(average);
  return (
    <div
      data-slot="rating-summary"
      className={cn('flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8', className)}
      {...props}
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-4xl font-bold text-amber-600 tabular-nums dark:text-amber-400">
          {average ?? '–'}
        </p>
        <StarRating value={value} />
        <p className="text-xs text-muted-foreground">
          {count === 0 ? 'No reviews yet' : `${count} rating${count === 1 ? '' : 's'}`}
        </p>
      </div>
      <ul className="flex flex-1 flex-col gap-1.5" aria-label="Rating distribution">
        {ROWS.map((rating) => {
          const n = histogram[`${rating}`];
          const pct = count === 0 ? 0 : Math.round((n / count) * 100);
          const text = `${rating} star${rating === 1 ? '' : 's'}: ${pct}%`;
          const bar = (
            <>
              <span
                aria-hidden="true"
                className="h-2 flex-1 overflow-hidden rounded-full bg-muted-foreground/20"
              >
                <span className="block h-full bg-amber-500" style={{ width: `${pct}%` }} />
              </span>
              <StarRating value={rating} className="shrink-0" starClassName="size-3" aria-hidden />
              <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {pct}%
              </span>
            </>
          );
          return (
            <li key={rating} data-testid="rating-row">
              {onSelectRating ? (
                <button
                  type="button"
                  aria-pressed={selectedRating === rating}
                  aria-label={text}
                  disabled={n === 0 && selectedRating !== rating}
                  onClick={() => onSelectRating(selectedRating === rating ? null : rating)}
                  className="flex w-full items-center gap-3 rounded-sm px-1 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 aria-pressed:bg-accent"
                >
                  {bar}
                </button>
              ) : (
                <div className="flex items-center gap-3 px-1" aria-label={text} role="group">
                  {bar}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export { RatingSummary };
