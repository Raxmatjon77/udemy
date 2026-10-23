'use client';

import { useQuery } from '@tanstack/react-query';
import { ErrorCode, type LandingLecture } from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@udemy/ui/components/dialog';
import { Skeleton } from '@udemy/ui/components/skeleton';
import type { RefObject } from 'react';

import { LecturePlayer } from '@/components/lecture-player';
import { catalogQueryKeys, fetchPreviewArticle } from '@/lib/catalog/client';
import { previewPlaylistPath, thumbnailPath } from '@/lib/catalog/format';
import { problemMessage } from '@/lib/problem';

/**
 * The free-preview modal (design §10): a video lecture plays in `<HlsPlayer>` from the public
 * playlist route through the BFF; an article lecture is fetched and rendered with the sanitized
 * `<MarkdownView>`. Radix Dialog: focus is trapped while open and returns to the "Preview"
 * button on close; Escape and the overlay close it.
 */
export function PreviewDialog({
  courseId,
  courseTitle,
  hasThumbnail,
  entitled = false,
  lecture,
  open,
  onOpenChange,
  returnFocusTo,
}: {
  courseId: string;
  courseTitle: string;
  /** `CourseLanding.hasThumbnail`: the poster is only requested when not false. */
  hasThumbnail?: boolean | undefined;
  /** The viewer is enrolled or the owner: any lecture opens, not only free previews. */
  entitled?: boolean;
  /** The lecture to preview (kept while the dialog closes). */
  lecture: LandingLecture | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control that opened the dialog: focus goes back there on close. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open && lecture !== null} onOpenChange={onOpenChange}>
      {lecture ? (
        <DialogContent
          className="sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo?.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogDescription>
              {entitled && !lecture.isPreview ? 'Lecture' : 'Course preview'} · {courseTitle}
            </DialogDescription>
            <DialogTitle>{lecture.title}</DialogTitle>
          </DialogHeader>
          {lecture.type === 'VIDEO' ? (
            <LecturePlayer
              src={previewPlaylistPath(courseId, lecture.id)}
              poster={hasThumbnail === false ? undefined : thumbnailPath(courseId, 'w750')}
              title={lecture.title}
            />
          ) : lecture.type === 'ARTICLE' ? (
            <ArticlePreview courseId={courseId} lectureId={lecture.id} />
          ) : (
            // RESOURCE lectures: a free preview never unlocks a download (P2-T11), so there is no
            // download link here; `GET /catalog/.../download` answers 403 `lecture_locked`.
            <p className="text-sm text-muted-foreground">This lecture has no preview.</p>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ArticlePreview({ courseId, lectureId }: { courseId: string; lectureId: string }) {
  const article = useQuery({
    queryKey: catalogQueryKeys.article(courseId, lectureId),
    queryFn: ({ signal }) => fetchPreviewArticle(courseId, lectureId, signal),
  });

  if (article.isPending) {
    return (
      <div role="status" aria-label="Loading article" className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }
  if (article.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          <p>
            {problemMessage(article.error, {
              [ErrorCode.LectureLocked]: 'This lecture is not available as a free preview.',
              [ErrorCode.NotFound]: 'This article is not available.',
              [ErrorCode.LectureNotFound]: 'This article is not available.',
              [ErrorCode.CourseNotFound]: 'This article is not available.',
            })}
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div data-testid="article-preview" className="max-h-[60dvh] overflow-y-auto pr-1">
      <MarkdownView source={article.data.bodyMd} idPrefix={`preview-${lectureId}-`} />
    </div>
  );
}
