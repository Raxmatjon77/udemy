import { authRoutes } from '@/lib/auth/handlers';

/** `POST /api/auth/refresh` (BFF, design §9). Origin-checked; never returns a token. */
export const POST = authRoutes.refresh;
