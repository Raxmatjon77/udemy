import type { Metadata } from 'next';

import { VerifyEmail } from './verify-email';

export const metadata: Metadata = { title: 'Verify your email' };

/**
 * Landing page of the verification email link (`/verify-email#token=…`). Always renders, signed
 * in or not, with `Referrer-Policy: no-referrer` (next.config.ts + proxy.ts).
 */
export default function VerifyEmailPage() {
  return <VerifyEmail />;
}
