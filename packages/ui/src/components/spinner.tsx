import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

/**
 * An indeterminate progress indicator. Decorative by default (`aria-hidden`): the surrounding
 * control should already say what is happening (e.g. a button reading "Signing in…"). Pass a
 * `label` to make it announce itself as a status instead.
 */
function Spinner({ className, label, ...props }: ComponentProps<'svg'> & { label?: string }) {
  return (
    <svg
      data-slot="spinner"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={cn(
        'size-4 animate-spin motion-reduce:animate-[spin_1.5s_linear_infinite]',
        className,
      )}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      {...props}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

export { Spinner };
