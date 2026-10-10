import 'server-only';
import { RevisionThumbnailQuerySchema, UuidSchema } from '@udemy/contracts';
import { createSignedRedirectHandler } from '@udemy/web-auth';

import { webAuthConfig } from './auth/config';

/**
 * API path of a revision's snapshotted thumbnail
 * (`GET /admin/course-revisions/:revisionId/thumbnail?variant=`, `course:read:any`), or null
 * (→ 404 without calling the API) when the id is not a UUID or the variant is unknown.
 */
export function revisionThumbnailApiPath(
  revisionId: string,
  searchParams: URLSearchParams,
): string | null {
  const id = UuidSchema.safeParse(revisionId);
  if (!id.success) return null;
  const query = RevisionThumbnailQuerySchema.safeParse({
    variant: searchParams.get('variant') ?? undefined,
  });
  if (!query.success) return null;
  return `/admin/course-revisions/${id.data}/thumbnail?variant=${query.data.variant}`;
}

/**
 * The admin session is forwarded, so the redirect is `private` and varies on cookies. A revision
 * is an immutable snapshot (its thumbnail asset is pinned), so the URL needs no cache key. API
 * errors (404 none, 409 `media_not_ready`, 403) pass through as `no-store` problems.
 */
export const revisionThumbnailRedirect = createSignedRedirectHandler<{ revisionId: string }>(
  webAuthConfig,
  {
    session: 'forward',
    apiPath: ({ params, searchParams }) =>
      revisionThumbnailApiPath(params.revisionId, searchParams),
  },
);
