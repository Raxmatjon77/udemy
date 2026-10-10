import { revisionThumbnailRedirect } from '@/lib/media-routes';

/**
 * `GET /media/revision-thumbnail/{revisionId}?variant=w750|w480`: a stable same-origin image URL
 * for the review page that 302s to a short-lived presigned URL of the revision's thumbnail
 * (design D11, §10; API `GET /admin/course-revisions/:revisionId/thumbnail`). Behind the admin
 * session gate (proxy.ts), like every page of this app.
 */
export const GET = revisionThumbnailRedirect;
