'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MEDIA_FAILURE_LABELS, type CourseDetail } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';

import { UploadField } from '@/components/upload-field';
import { catalogApi } from '@/lib/catalog-api';
import { isTerminal, setCourseData, useAssetStatus } from '@/lib/catalog-queries';
import { MEDIA_STATUS_LABELS } from '@/lib/labels';
import { problemMessage } from '@/lib/problem';

/**
 * Course image: upload (COURSE_THUMBNAIL, re-encoded server-side to 16:9 JPEG), then
 * `PUT /courses/:id/thumbnail`. While it processes the status is polled.
 *
 * A READY image is shown through this app's signed-redirect route
 * (`/media/course-thumbnail/{id}`, which calls `GET /courses/:id/thumbnail` with the owner's
 * session). While it is uploading or processing (the API would answer 409 `media_not_ready`) no
 * image is requested: the file chosen in this session is shown from a local `blob:` URL (CSP
 * `img-src` allows it), otherwise the status. A failed image load falls back to the file name.
 */
export function ThumbnailField({ course, readOnly }: { course: CourseDetail; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const asset = useAssetStatus(course.thumbnail);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  function showPreview(file: File) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    setPreviewUrl(url);
  }

  const remove = useMutation({
    mutationFn: () => catalogApi.clearThumbnail(course.id),
    onSuccess: (updated) => {
      setCourseData(queryClient, updated);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      setPreviewUrl(null);
    },
  });

  const current = asset.data ?? null;
  const [brokenImage, setBrokenImage] = useState<string | null>(null);
  const serverImage =
    current?.status === 'READY' && brokenImage !== current.id
      ? catalogApi.thumbnailImageUrl(course.id, current.id)
      : null;

  return (
    <section aria-labelledby="thumbnail-heading" className="grid gap-4">
      <h3 id="thumbnail-heading" className="text-base font-semibold">
        Course image
      </h3>
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md border bg-muted text-center text-xs text-muted-foreground">
          {serverImage && current ? (
            // A 302 to a short-lived presigned URL; next/image would have to fetch MinIO itself.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={serverImage}
              alt="Current course image"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
              onError={() => setBrokenImage(current.id)}
            />
          ) : previewUrl ? (
            // A local blob: preview; next/image cannot optimise it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="Selected course image"
              className="h-full w-full object-cover"
            />
          ) : current ? (
            <span className="grid gap-1 px-3">
              <span>{current.originalFilename}</span>
              {current.status === 'READY' ? (
                <span>The image could not be loaded.</span>
              ) : !isTerminal(current.status) ? (
                <span>The image appears here once it is processed.</span>
              ) : null}
            </span>
          ) : (
            <span className="px-3">No image yet</span>
          )}
        </div>
        <div className="grid content-start gap-3">
          {current ? (
            <p className="text-sm" role="status" aria-live="polite">
              <span className="font-medium">{MEDIA_STATUS_LABELS[current.status]}</span>
              {current.status === 'PROCESSING' && current.progressPct !== null
                ? ` (${current.progressPct}%)`
                : null}
              {current.status === 'FAILED' && current.failureCode
                ? `: ${MEDIA_FAILURE_LABELS[current.failureCode]}`
                : null}
            </p>
          ) : null}
          <UploadField
            purpose="COURSE_THUMBNAIL"
            slotKey={`thumbnail:${course.id}`}
            inputId="course-thumbnail"
            label={current ? 'Replace image' : 'Upload image'}
            description="JPEG, PNG or WebP, up to 5 MB. Use a 16:9 image of at least 750 × 422 pixels."
            disabled={readOnly}
            onFileSelected={showPreview}
            onComplete={async (uploaded) => {
              const updated = await catalogApi.setThumbnail(course.id, uploaded.id);
              setCourseData(queryClient, updated);
            }}
          />
          {current && !readOnly ? (
            <div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                Remove image
              </Button>
            </div>
          ) : null}
          {remove.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {problemMessage(remove.error)}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
