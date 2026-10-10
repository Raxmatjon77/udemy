import { authRoutes } from '@/lib/auth/handlers';

/** `POST /api/auth/logout-all` (BFF, design §9). Origin-checked; never returns a token. */
export const POST = authRoutes.logoutAll;
