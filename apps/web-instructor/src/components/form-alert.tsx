import { Alert, AlertDescription } from '@udemy/ui/components/alert';

/**
 * Form-level error (`errors.root.server`). The live region is always rendered, so screen
 * readers announce the message as soon as it appears.
 */
export function FormAlert({ message }: { message?: string | undefined }) {
  return (
    <div role="alert" aria-live="assertive" aria-atomic="true">
      {message ? (
        <Alert variant="destructive">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
