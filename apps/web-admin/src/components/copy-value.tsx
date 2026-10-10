'use client';

import { useState } from 'react';
import { Button } from '@udemy/ui/components/button';

/**
 * A provider id (Checkout Session, payment intent, refund) in monospace with a copy button.
 * The result is announced politely; a browser without clipboard access says so.
 */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code className="font-mono text-xs break-all">{value}</code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7"
        aria-label={`Copy ${label}`}
        onClick={() => void copy()}
      >
        Copy
      </Button>
      <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
