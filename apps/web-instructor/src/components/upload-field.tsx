'use client';

import { useId, useState, type ChangeEvent } from 'react';
import { MEDIA_PURPOSE_RULES, type MediaPurpose } from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Label } from '@udemy/ui/components/label';

import { formatBytes } from '@/lib/format';
import {
  describePending,
  useResumableUpload,
  type UseResumableUploadOptions,
} from '@/lib/upload/use-resumable-upload';

const PHASE_TEXT = {
  preparing: 'Preparing upload…',
  uploading: 'Uploading…',
  completing: 'Finishing upload…',
} as const;

export interface UploadFieldProps extends Omit<UseResumableUploadOptions, 'purpose' | 'slotKey'> {
  purpose: MediaPurpose;
  slotKey: string;
  label: string;
  /** Help text under the picker. */
  description?: string;
  disabled?: boolean;
  /** Called with the chosen file before the upload starts (e.g. for a local image preview). */
  onFileSelected?: (file: File) => void;
  /** id for the file input (so a readiness link can focus it). */
  inputId?: string;
}

/**
 * File picker + resumable upload with progress, cancel and retry (design §10). Accessible: a
 * native file input with a label, a `<progress>` with a text equivalent, and a polite live
 * region for phase changes. After a reload, an unfinished upload is offered for resuming.
 */
export function UploadField({
  purpose,
  slotKey,
  label,
  description,
  disabled = false,
  onFileSelected,
  inputId,
  ...hookOptions
}: UploadFieldProps) {
  const generatedId = useId();
  const id = inputId ?? `upload-${generatedId}`;
  const upload = useResumableUpload({ purpose, slotKey, ...hookOptions });
  const { state } = upload;
  const [canceling, setCanceling] = useState(false);
  const accept = MEDIA_PURPOSE_RULES[purpose].contentTypes.join(',');
  const percent = Math.round(upload.progress * 100);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    onFileSelected?.(file);
    void upload.start(file);
  }

  async function cancel() {
    setCanceling(true);
    try {
      await upload.cancel();
    } finally {
      setCanceling(false);
    }
  }

  const descriptionId = `${id}-description`;
  const statusText = upload.busy
    ? `${PHASE_TEXT[state.phase as keyof typeof PHASE_TEXT]} ${percent}%`
    : state.phase === 'done'
      ? `Upload of ${state.fileName ?? 'the file'} complete.`
      : state.phase === 'canceled'
        ? 'Upload cancelled.'
        : '';

  return (
    <div className="grid gap-2" data-slot="upload-field">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled || upload.busy}
        onChange={onChange}
        aria-describedby={descriptionId}
        className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent disabled:opacity-50"
      />
      <p id={descriptionId} className="text-xs text-muted-foreground">
        {description ??
          `Allowed: ${MEDIA_PURPOSE_RULES[purpose].contentTypes.join(', ')}. Up to ${formatBytes(MEDIA_PURPOSE_RULES[purpose].maxBytes)}.`}
      </p>

      {upload.pending && !disabled ? (
        <Alert variant="warning">
          <AlertDescription className="grid gap-2">
            <p>
              Upload paused: {describePending(upload.pending)}. Select the same file again to
              continue where it stopped.
            </p>
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => void cancel()} disabled={canceling}>
                Discard paused upload
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {upload.busy || state.phase === 'done' ? (
        <div className="grid gap-1">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate">{state.fileName}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatBytes(state.loaded)} / {formatBytes(state.total)}
            </span>
          </div>
          <progress
            className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
            max={100}
            value={percent}
            aria-label={`Upload progress of ${state.fileName ?? 'the file'}`}
          >
            {percent}%
          </progress>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {statusText}
      </p>

      {state.phase === 'error' && state.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="grid gap-2">
            <p>{state.error}</p>
            {upload.canRetry ? (
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={upload.retry}>
                  Retry
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void cancel()}>
                  Cancel upload
                </Button>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {upload.busy ? (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => void cancel()} disabled={canceling}>
            Cancel upload
          </Button>
        </div>
      ) : null}
    </div>
  );
}

