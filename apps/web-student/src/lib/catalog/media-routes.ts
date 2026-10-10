import 'server-only';
import { ThumbnailQuerySchema, UuidSchema } from '@udemy/contracts';
import { createSignedRedirectHandler } from '@udemy/web-auth';

import { webAuthConfig } from '../auth/config';

/**
 * API path of a course thumbnail, or null (→ 404 without calling the API) when the id is not a
 * UUID or the variant is unknown. Nothing from the URL reaches the API path unchecked.
 */
export function courseThumbnailApiPath(
  courseId: string,
  searchParams: URLSearchParams,
): string | null {
  const id = UuidSchema.safeParse(courseId);
  if (!id.success) return null;
  const query = ThumbnailQuerySchema.safeParse({
    variant: searchParams.get('variant') ?? undefined,
  });
  if (!query.success) return null;
  return `/catalog/courses/${id.data}/images/thumbnail?variant=${query.data.variant}`;
}

/** Anonymous (`session: 'none'`): the same public redirect for everybody, shared caches OK. */
export const courseThumbnailRedirect = createSignedRedirectHandler<{ courseId: string }>(
  webAuthConfig,
  {
    apiPath: ({ params, searchParams }) => courseThumbnailApiPath(params.courseId, searchParams),
  },
);
