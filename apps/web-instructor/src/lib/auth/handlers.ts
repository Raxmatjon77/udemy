import 'server-only';
import {
  createApiProxyHandler,
  createAuthRouteHandlers,
  createRealtimeTicketHandler,
} from '@udemy/web-auth';

import { webAuthConfig } from './config';

/*
 * The config is passed as a thunk: @udemy/web-auth resolves (and validates) it on the first
 * request, so `next build` can import every route module without the server secrets.
 */

/** `POST /api/auth/{login,logout,logout-all,refresh}`. */
export const authRoutes = createAuthRouteHandlers(webAuthConfig);

/** `/api/proxy/*` → the API with the session's access token. */
export const apiProxy = createApiProxyHandler(webAuthConfig);

/** `POST /api/realtime/ticket` → a single-use socket.io ticket (Phase 5 D16). */
export const realtimeTicket = createRealtimeTicketHandler(webAuthConfig);
