import 'server-only';
import { connection } from 'next/server';
import { createGetSession, type GetSession, type Session } from '@udemy/web-auth/session';

import { getWebAuthConfig } from './config';

export type { Session };

let reader: GetSession | undefined;

/**
 * The signed-in user of this request (id + roles), or null. For server components only.
 * `connection()` opts the caller out of prerendering first, so the config (and its secrets) is
 * only ever touched at request time.
 */
export async function getSession(): Promise<Session | null> {
  await connection();
  reader ??= createGetSession(getWebAuthConfig());
  return reader();
}
