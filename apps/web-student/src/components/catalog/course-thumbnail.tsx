'use client';

import type { ThumbnailVariant } from '@udemy/contracts';
import { cn } from '@udemy/ui/lib/utils';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

import { thumbnailPath } from '@/lib/catalog/format';

/**
 * A course thumbnail through the stable image route (`/media/course-thumbnail/{id}`, a 302 to a
 * presigned MinIO URL). `unoptimized`: the Next image optimizer would have to fetch MinIO
 * itself (and need `remotePatterns`); the transcoder already produced the sized variants.
 *
 * `hasThumbnail === false` (contracts `CourseCard`/`CourseLanding.hasThumbnail`): the placeholder
 * is rendered at once, without an image request. When the flag is absent (older API) the route is
 * tried, and a 404 falls back to the same placeholder. The `complete && naturalWidth === 0` check
 * catches an error that fired before hydration.
 */
export function CourseThumbnail({
  courseId,
  title,
  hasThumbnail,
  variant = 'w480',
  priority = false,
  className,
  sizes = '(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw',
}: {
  courseId: string;
  /** Used for the placeholder only; the image itself is decorative next to the title. */
  title: string;
  /** From the API; `false` skips the image request, `undefined` means unknown. */
  hasThumbnail?: boolean | undefined;
  variant?: ThumbnailVariant;
  priority?: boolean;
  className?: string;
  sizes?: string;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && img.currentSrc) setFailed(true);
  }, []);

  return (
    <div
      data-slot="course-thumbnail"
      className={cn(
        'relative aspect-video w-full overflow-hidden bg-gradient-to-br from-accent to-muted',
        className,
      )}
    >
      {failed || hasThumbnail === false ? (
        <span
          aria-hidden="true"
          data-slot="thumbnail-placeholder"
          className="absolute inset-0 flex items-center justify-center p-4 text-center text-3xl font-semibold text-primary/40 select-none"
        >
          {initials(title)}
        </span>
      ) : (
        <Image
          ref={ref}
          src={thumbnailPath(courseId, variant)}
          alt=""
          fill
          unoptimized
          sizes={sizes}
          priority={priority}
          referrerPolicy="no-referrer"
          className="object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function initials(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}
