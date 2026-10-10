'use client';

import { useState, type ComponentProps } from 'react';
import { Input } from '@udemy/ui/components/input';

/** Password field with a show/hide toggle (a real button with `aria-pressed`). */
export function PasswordInput(props: Omit<ComponentProps<typeof Input>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className="pr-16" />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        aria-pressed={visible}
        aria-label={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex items-center rounded-r-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
