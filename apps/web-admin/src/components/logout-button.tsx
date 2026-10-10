'use client';

import { useState, type ComponentProps } from 'react';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';
import { logout } from '@udemy/web-auth/client';

/**
 * Ends this session (`POST /api/auth/logout`), tells other tabs and goes to `redirectTo`.
 * Logout always completes locally: the BFF clears the cookies even when the API is down, and
 * `logout()` still broadcasts and navigates when the BFF cannot be reached.
 */
export function LogoutButton({
  redirectTo = '/login',
  children = 'Log out',
  ...props
}: Omit<ComponentProps<typeof Button>, 'onClick'> & { redirectTo?: string }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      {...props}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void logout({ loginPath: redirectTo });
      }}
    >
      {pending ? <Spinner /> : null}
      {pending ? 'Logging out…' : children}
    </Button>
  );
}
