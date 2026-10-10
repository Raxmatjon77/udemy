'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MEDIA_FAILURE_LABELS, type CourseDetail } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';

import { UploadField } from '@/components/upload-field';
import { catalogApi } from '@/lib/catalog-api';
import { setCourseData, useAssetStatus } from '@/lib/catalog-queries';
import { MEDIA_STATUS_LABELS } from '@/lib/labels';
import { problemMessage } from '@/lib/problem';

/**
 * Course image: upload (COURSE_THUMBNAIL, re-encoded server-side to 16:9 JPEG), then
 * `PUT /courses/:id/thumbnail`. While it processes the status is polled.
 *
 * The preview shows the file chosen in this session (a local `blob:` URL; CSP `img-src` allows
 * it). Contract gap: there is no instructor endpoint for a signed URL of the working-copy
 * thumbnail, so a previously uploaded image is described, not shown.
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

  return (
    <section aria-labelledby="thumbnail-heading" className="grid gap-4">
      <h3 id="thumbnail-heading" className="text-base font-semibold">
        Course image
      </h3>
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md border bg-muted text-center text-xs text-muted-foreground">
          {previewUrl ? (
            // A local blob: preview; next/image cannot optimise it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="Selected course image"
              className="h-full w-full object-cover"
            />
          ) : current ? (
            <span className="px-3">{current.originalFilename}</span>
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
