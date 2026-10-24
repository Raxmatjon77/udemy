'use client';

import { useId, type ComponentProps } from 'react';

import { cn } from '../lib/utils';

/*
 * Star ratings (Phase 5 design §10): `StarRating` shows a 0–5 value (fractions fill a star
 * partially), announced as one image ("Rated 4.6 out of 5"); `StarRatingInput` is a native radio
 * group (arrow keys, form semantics) with one radio per star.
 */

const STARS = [1, 2, 3, 4, 5] as const;

function StarIcon({ fill, className }: { fill: number; className?: string }) {
  const id = useId();
  const pct = Math.round(Math.min(1, Math.max(0, fill)) * 100);
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4', className)} aria-hidden="true">
      <defs>
        <linearGradient id={id}>
          <stop offset={`${pct}%`} stopColor="currentColor" />
          <stop offset={`${pct}%`} stopColor="currentColor" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"
      />
    </svg>
  );
}

function StarRating({
  value,
  className,
  starClassName,
  label,
  ...props
}: Omit<ComponentProps<'span'>, 'role'> & {
  /** 0–5 (e.g. `4.6`); null shows empty stars ("No ratings yet"). */
  value: number | null;
  starClassName?: string;
  /** Accessible name; default "Rated {value} out of 5". */
  label?: string;
}) {
  const rating = value === null ? 0 : Math.min(5, Math.max(0, value));
  return (
    <span
      data-slot="star-rating"
      role="img"
      aria-label={label ?? (value === null ? 'No ratings yet' : `Rated ${value} out of 5`)}
      className={cn('inline-flex items-center gap-0.5 text-amber-500', className)}
      {...props}
    >
      {STARS.map((star) => (
        <StarIcon key={star} fill={rating - (star - 1)} className={starClassName} />
      ))}
    </span>
  );
}

function StarRatingInput({
  value,
  onChange,
  name,
  legend,
  disabled,
  className,
}: {
  value: number | null;
  onChange: (value: number) => void;
  name?: string;
  /** The group's accessible name, e.g. "Your rating". */
  legend: string;
  disabled?: boolean;
  className?: string;
}) {
  const generated = useId();
  const group = name ?? generated;
  return (
    <fieldset
      data-slot="star-rating-input"
      disabled={disabled}
      className={cn('flex flex-col gap-1', className)}
    >
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex items-center gap-1 text-amber-500">
        {STARS.map((star) => (
          <label
            key={star}
            className="cursor-pointer rounded-sm has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 has-disabled:cursor-not-allowed"
          >
            <input
              type="radio"
              name={group}
              value={star}
              checked={value === star}
              onChange={() => onChange(star)}
              className="sr-only"
            />
            <span className="sr-only">{`${star} star${star === 1 ? '' : 's'}`}</span>
            <StarIcon fill={value !== null && star <= value ? 1 : 0} className="size-7" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export { StarRating, StarRatingInput };
