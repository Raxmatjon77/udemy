'use client';

import { useDeferredValue, useRef } from 'react';
import { MarkdownView } from '@udemy/markdown/react';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Label } from '@udemy/ui/components/label';
import { Textarea } from '@udemy/ui/components/textarea';

import { offsetOf, type MarkdownIssueView } from '@/lib/markdown-issues';

export interface MarkdownEditorProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  /** Field validation message (length etc.). */
  error?: string | undefined;
  /** Constructs the api rejected (422 `markdown_not_allowed`), with line/column. */
  issues?: MarkdownIssueView[] | null;
  description?: string;
  maxLength?: number;
  rows?: number;
  /** Callback ref (e.g. react-hook-form's `field.ref`, for focusing on errors). */
  textareaRef?: (node: HTMLTextAreaElement | null) => void;
}

/**
 * Split markdown editor: source on the left, the live `<MarkdownView>` preview (the exact
 * renderer students see) on the right. Rejected constructs are listed with their line and
 * column; choosing one puts the cursor there.
 */
export function MarkdownEditor({
  id,
  label,
  value,
  onChange,
  onBlur,
  name,
  disabled = false,
  error,
  issues,
  description,
  maxLength,
  rows = 12,
  textareaRef,
}: MarkdownEditorProps) {
  const local = useRef<HTMLTextAreaElement | null>(null);
  const preview = useDeferredValue(value);
  const issuesId = `${id}-issues`;
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;
  const describedBy =
    [description ? descriptionId : null, error ? errorId : null, issues?.length ? issuesId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  function setRefs(node: HTMLTextAreaElement | null) {
    local.current = node;
    textareaRef?.(node);
  }

  function goTo(issue: MarkdownIssueView) {
    const node = local.current;
    if (!node || issue.line === null) return;
    const offset = offsetOf(node.value, issue.line, issue.column ?? 1);
    node.focus();
    node.setSelectionRange(offset, offset);
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {maxLength ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {value.length.toLocaleString('en')} / {maxLength.toLocaleString('en')}
          </span>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Textarea
          ref={setRefs}
          id={id}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          rows={rows}
          spellCheck
          aria-invalid={Boolean(error) || Boolean(issues?.length)}
          aria-describedby={describedBy}
          className="min-h-48 font-mono text-sm [field-sizing:fixed]"
        />
        <section
          aria-label={`${label} preview`}
          className="max-h-[32rem] min-h-48 overflow-y-auto rounded-md border bg-muted/30 px-4 py-3"
        >
          {preview.trim() ? (
            <MarkdownView source={preview} idPrefix={`${id}-preview-`} />
          ) : (
            <p className="text-sm text-muted-foreground">The preview appears here as you type.</p>
          )}
        </section>
      </div>
      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {issues?.length ? (
        <Alert variant="destructive" id={issuesId}>
          <AlertTitle>Some formatting is not allowed</AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1" aria-label="Formatting problems">
              {issues.map((issue, index) => (
                <li key={`${issue.line}-${issue.column}-${index}`}>
                  {issue.line !== null ? (
                    <button
                      type="button"
                      onClick={() => goTo(issue)}
                      className="font-medium underline underline-offset-4"
                    >
                      Line {issue.line}, column {issue.column}
                    </button>
                  ) : null}
                  {issue.line !== null ? ': ' : null}
                  {issue.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
