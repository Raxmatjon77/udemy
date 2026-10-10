import { workingThumbnailRedirect } from '@/lib/media-routes';

/**
 * `GET /media/course-thumbnail/{courseId}?variant=w750|w480[&v=<assetId>]`: a stable same-origin
 * image URL for the builder that 302s to a short-lived presigned URL of the working-copy
 * thumbnail (design D11, §10; API `GET /courses/:id/thumbnail`). Behind the session gate
 * (proxy.ts), like every page of this app. `v` only changes the URL when the image is replaced.
 */
export const GET = workingThumbnailRedirect;
