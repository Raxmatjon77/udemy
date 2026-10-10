import 'server-only';
import {
  createApiProxyHandler,
  createAuthRouteHandlers,
  type ApiProxyHandler,
  type AuthRouteHandlers,
} from '@udemy/web-auth';

import { getWebAuthConfig } from './config';

/*
 * The handlers are created on first use, not at import: `next build` imports every route
 * module, and must not need the server secrets to do so.
 */

let routes: AuthRouteHandlers | undefined;
let proxy: ApiProxyHandler | undefined;

export function authRoutes(): AuthRouteHandlers {
  routes ??= createAuthRouteHandlers(getWebAuthConfig());
  return routes;
}

export function apiProxy(): ApiProxyHandler {
  proxy ??= createApiProxyHandler(getWebAuthConfig());
  return proxy;
}
