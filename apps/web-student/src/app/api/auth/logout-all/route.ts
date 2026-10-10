import { authRoutes } from '@/lib/auth/handlers';

/** `POST /api/auth/logout-all` (BFF, design §9). Origin-checked; never returns a token. */
export function POST(request: Request): Promise<Response> {
  return authRoutes().logoutAll(request);
}
