import { apiProxy } from '@/lib/auth/handlers';

/**
 * `/api/proxy/*` → `API_INTERNAL_URL/api/v1/*` with the session's access token (design §9).
 * Refresh tokens never pass through here: `auth/login|refresh|logout` are denied.
 */
export {
  apiProxy as GET,
  apiProxy as POST,
  apiProxy as PUT,
  apiProxy as PATCH,
  apiProxy as DELETE,
};
