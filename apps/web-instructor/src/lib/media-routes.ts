import 'server-only';
import { CourseThumbnailQuerySchema, UuidSchema } from '@udemy/contracts';
import { createSignedRedirectHandler } from '@udemy/web-auth';

import { webAuthConfig } from './auth/config';

/**
 * API path of the WORKING-COPY thumbnail (`GET /courses/:id/thumbnail?variant=`, owner or admin),
 * or null (→ 404 without calling the API) when the id is not a UUID or the variant is unknown.
 * Other query parameters (the `v` cache key) are ignored.
 */
export function workingThumbnailApiPath(
  courseId: string,
  searchParams: URLSearchParams,
): string | null {
  const id = UuidSchema.safeParse(courseId);
  if (!id.success) return null;
  const query = CourseThumbnailQuerySchema.safeParse({
    variant: searchParams.get('variant') ?? undefined,
  });
  if (!query.success) return null;
  return `/courses/${id.data}/thumbnail?variant=${query.data.variant}`;
}

/**
 * The owner's session is forwarded (the working copy is not public), so the redirect is
 * `private` and varies on cookies. API errors (404 no thumbnail, 409 `media_not_ready`) pass
 * through as `no-store` problems; the `<img>` then shows its fallback.
 */
export const workingThumbnailRedirect = createSignedRedirectHandler<{ courseId: string }>(
  webAuthConfig,
  {
    session: 'forward',
    apiPath: ({ params, searchParams }) => workingThumbnailApiPath(params.courseId, searchParams),
  },
);
