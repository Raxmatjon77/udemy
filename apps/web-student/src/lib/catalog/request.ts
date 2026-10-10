import 'server-only';
import { headers } from 'next/headers';

import { serverEnv } from '../env';

/** This response's CSP nonce, set on the request by `createAuthProxy` (src/proxy.ts). */
export async function cspNonce(): Promise<string | undefined> {
  return (await headers()).get('x-nonce') ?? undefined;
}

/** `APP_ORIGIN`: absolute, canonical URLs for metadata and structured data. */
export function appOrigin(): string {
  return serverEnv().APP_ORIGIN.replace(/\/+$/, '');
}
