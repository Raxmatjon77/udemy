import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

/**
 * A determinate progress bar (`role="progressbar"`, 0–100). Give it an accessible name with
 * `aria-label` or `aria-labelledby`.
 */
function Progress({
  value,
  className,
  indicatorClassName,
  ...props
}: Omit<ComponentProps<'div'>, 'role'> & { value: number; indicatorClassName?: string }) {
  const pct = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/15', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn('h-full bg-primary transition-[width]', indicatorClassName)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export { Progress };
