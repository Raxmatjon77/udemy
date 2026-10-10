import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import { Label } from './label';

/** ARIA props a form control needs to be linked to its description and error message. */
export interface FieldControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby'?: string;
}

export interface FormFieldProps {
  /** The control's id; the label, description and error ids are derived from it. */
  id: string;
  label: ReactNode;
  /** Help text shown under the control (announced with it via aria-describedby). */
  description?: ReactNode;
  /** Validation message; when set the control is marked `aria-invalid`. */
  error?: string | undefined;
  /** Shown after the label, e.g. "Optional". */
  hint?: ReactNode;
  className?: string;
  /** Render the control, spreading the given props onto it. */
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + control + description + error, with the accessibility wiring done once:
 *
 * ```tsx
 * <FormField id="email" label="Email" error={errors.email?.message}>
 *   {(field) => <Input {...field} type="email" {...register('email')} />}
 * </FormField>
 * ```
 *
 * The error is a plain paragraph (not a live region): forms announce a summary on submit and
 * move focus to the first invalid field, which then reads its own error via aria-describedby.
 */
function FormField({ id, label, description, error, hint, className, children }: FormFieldProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div data-slot="form-field" className={cn('grid gap-2', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {children({
        id,
        'aria-invalid': Boolean(error),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      })}
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
    </div>
  );
}

export { FormField };
