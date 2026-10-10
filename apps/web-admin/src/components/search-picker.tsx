'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@udemy/ui/components/button';
import { Input } from '@udemy/ui/components/input';
import { Label } from '@udemy/ui/components/label';
import { Spinner } from '@udemy/ui/components/spinner';

import { problemMessage } from '@/lib/problem';

export interface PickerOption {
  id: string;
  label: string;
  /** A second line, e.g. the email or the course status. */
  detail?: string;
}

export interface SearchPickerProps {
  /** Base id of the controls (the label points at the search input). */
  id: string;
  label: string;
  placeholder?: string;
  /** The chosen option, or null. */
  value: PickerOption | null;
  onChange: (option: PickerOption | null) => void;
  /** Runs a search; the API searches need at least 3 characters. */
  search: (term: string) => Promise<PickerOption[]>;
  /** Query key prefix for caching the results. */
  queryKey: readonly unknown[];
  error?: string | undefined;
  description?: string;
}

const MIN_TERM = 3;

/**
 * "Find, then pick": a search box with a Search button that lists matches as buttons. Once
 * picked, the choice is shown with a "Change" button. Used for the buyer and course filters
 * and the course to grant. Searching never submits the surrounding form.
 */
export function SearchPicker({
  id,
  label,
  placeholder,
  value,
  onChange,
  search,
  queryKey,
  error,
  description,
}: SearchPickerProps) {
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const resultsId = useId();
  const results = useQuery({
    queryKey: [...queryKey, term],
    queryFn: () => search(term ?? ''),
    enabled: term !== null,
    staleTime: 30_000,
  });

  function run() {
    const next = draft.trim();
    if (next.length < MIN_TERM) {
      setHint(`Enter at least ${MIN_TERM} characters.`);
      return;
    }
    setHint(null);
    setTerm(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  }

  const message = error ?? hint ?? undefined;
  const describedBy =
    [description ? `${id}-description` : null, message ? `${id}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined;

  if (value) {
    return (
      <div className="grid gap-2">
        <span className="text-sm font-medium" id={`${id}-label`}>
          {label}
        </span>
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
          aria-labelledby={`${id}-label`}
          role="group"
        >
          <span className="grid">
            <span className="font-medium">{value.label}</span>
            {value.detail ? (
              <span className="text-xs text-muted-foreground">{value.detail}</span>
            ) : null}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            aria-label={`Change ${label.toLowerCase()}`}
            onClick={() => {
              onChange(null);
              setTerm(null);
            }}
          >
            Change
          </Button>
        </div>
        {error ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const items = results.data ?? [];

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="search"
          value={draft}
          placeholder={placeholder}
          aria-invalid={Boolean(message)}
          aria-describedby={describedBy}
          aria-controls={term !== null ? resultsId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="button" variant="outline" onClick={run} aria-label={`Search ${label}`}>
          Search
        </Button>
      </div>
      {description ? (
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {message ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
      {term !== null ? (
        <div id={resultsId} aria-live="polite" className="grid gap-1">
          {results.isFetching ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Searching…
            </span>
          ) : results.isError ? (
            <span className="text-sm text-destructive">{problemMessage(results.error)}</span>
          ) : items.length === 0 ? (
            <span className="text-sm text-muted-foreground">No matches.</span>
          ) : (
            <ul className="grid max-h-60 gap-1 overflow-y-auto" aria-label={`${label} matches`}>
              {items.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    className="grid w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => onChange(option)}
                  >
                    <span className="font-medium">{option.label}</span>
                    {option.detail ? (
                      <span className="text-xs text-muted-foreground">{option.detail}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
