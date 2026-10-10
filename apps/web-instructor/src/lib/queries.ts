import { useQuery } from '@tanstack/react-query';
import { MeResponseSchema, type MeResponse } from '@udemy/contracts';

import { api } from './api';

/** TanStack Query keys of this app, in one place so invalidation stays consistent. */
export const queryKeys = {
  me: ['me'] as const,
};

/** `GET /me`. `quiet`: a 401 means "signed out" instead of redirecting to login. */
export function useMe({
  enabled = true,
  quiet = false,
}: { enabled?: boolean; quiet?: boolean } = {}) {
  return useQuery<MeResponse>({
    queryKey: queryKeys.me,
    queryFn: () => api('/me', { schema: MeResponseSchema, quiet }),
    enabled,
  });
}
