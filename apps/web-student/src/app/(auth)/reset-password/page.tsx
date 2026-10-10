import type { Metadata } from 'next';

import { ResetPassword } from './reset-password';

export const metadata: Metadata = { title: 'Choose a new password' };

/**
 * Landing page of the password reset email (`/reset-password#token=…`). Always renders, with
 * `Referrer-Policy: no-referrer` (next.config.ts + proxy.ts).
 */
export default function ResetPasswordPage() {
  return <ResetPassword />;
}
