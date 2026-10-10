import 'server-only';
import { createGetSession, type Session } from '@udemy/web-auth/session';

import { webAuthConfig } from './config';

export type { Session };

/**
 * The signed-in user of this request (id + roles), or null. For server components only.
 * It reads `cookies()` before the (lazy) config, so prerendering bails out before the server
 * secrets are touched.
 */
export const getSession = createGetSession(webAuthConfig);
