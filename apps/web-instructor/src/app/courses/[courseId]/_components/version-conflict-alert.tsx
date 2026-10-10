'use client';

import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';

/**
 * 409 `version_conflict` on save: someone (usually another tab) changed the course after this
 * form was loaded. Saving again would overwrite their change, so the only way forward is to
 * reload the latest version (unsaved edits in this form are replaced).
 */
export function VersionConflictAlert({
  onReload,
  reloading,
}: {
  onReload: () => void;
  reloading: boolean;
}) {
  return (
    <div role="alert">
      <Alert variant="warning">
        <AlertTitle>This course was changed somewhere else</AlertTitle>
        <AlertDescription className="grid gap-3">
          <p>
            Someone saved a newer version of this course (for example in another tab) after you
            opened it. Reload the latest version to continue editing. Your unsaved changes in this
            form will be replaced, so copy anything you want to keep first.
          </p>
          <div>
            <Button type="button" size="sm" onClick={onReload} disabled={reloading}>
              {reloading ? (
                <>
                  <Spinner /> Reloading…
                </>
              ) : (
                'Reload latest version'
              )}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
