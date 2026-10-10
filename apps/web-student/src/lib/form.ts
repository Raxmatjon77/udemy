import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { toFormProblem, type FormProblemOptions } from './problem';

/** react-hook-form key for the form-level server message (`errors.root.server`). */
export const ROOT_SERVER = 'root.server' as const;

/**
 * Applies an API error to a react-hook-form form: field errors via `setError` (focusing the
 * first one), everything else as `errors.root.server`, rendered by `<FormAlert>`.
 */
export function applyServerError<T extends FieldValues>(
  setError: UseFormSetError<T>,
  error: unknown,
  options: FormProblemOptions<Path<T> & string>,
): void {
  const { fieldErrors, formError } = toFormProblem(error, options);
  let focused = false;
  for (const [field, message] of Object.entries(fieldErrors) as [Path<T>, string][]) {
    setError(field, { type: 'server', message }, { shouldFocus: !focused });
    focused = true;
  }
  if (formError) setError(ROOT_SERVER, { type: 'server', message: formError });
}
