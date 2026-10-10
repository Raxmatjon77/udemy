'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@udemy/ui/lib/utils';

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * WAI-ARIA tabs (automatic activation): arrow keys, Home and End move between tabs; only the
 * active panel is rendered, so inactive tabs do not fetch.
 */
export function Tabs({
  label,
  items,
  defaultTab,
}: {
  label: string;
  items: readonly TabItem[];
  defaultTab?: string;
}) {
  const [active, setActive] = useState(defaultTab ?? items[0]?.id ?? '');
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());

  function focusAt(index: number) {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    setActive(item.id);
    refs.current.get(item.id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowRight') focusAt(index + 1);
    else if (event.key === 'ArrowLeft') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(items.length - 1);
    else return;
    event.preventDefault();
  }

  const current = items.find((item) => item.id === active) ?? items[0];

  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label={label} className="flex gap-1 border-b">
        {items.map((item, index) => {
          const selected = item.id === current?.id;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) refs.current.set(item.id, node);
                else refs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(item.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                selected
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {current ? (
        <div
          role="tabpanel"
          id={`${base}-panel-${current.id}`}
          aria-labelledby={`${base}-tab-${current.id}`}
          className="grid gap-6"
        >
          {current.content}
        </div>
      ) : null}
    </div>
  );
}
