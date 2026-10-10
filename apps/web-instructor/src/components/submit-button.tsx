import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';

/**
 * A submit button that shows progress. While `pending` it is disabled and says what is
 * happening (`pendingLabel`), so the state is announced without extra live regions.
 */
export function SubmitButton({
  pending,
  pendingLabel,
  children,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pending: boolean; pendingLabel: ReactNode }) {
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? (
        <>
          <Spinner />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
