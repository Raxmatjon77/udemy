import { courseThumbnailRedirect } from '@/lib/catalog/media-routes';

/**
 * `GET /media/course-thumbnail/{courseId}?variant=w750|w480`: a stable, cacheable image URL that
 * 302s to a short-lived presigned MinIO URL (design D11, §10). Public: `/media/*` is in
 * `PUBLIC_PATHS`, and the API is called anonymously.
 */
export const GET = courseThumbnailRedirect;
