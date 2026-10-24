'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  MANUALLY_COMPLETABLE_LECTURE_TYPES,
  type ClientCompletionCause,
  type PlayerBootstrap,
  type PlayerLecture,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Checkbox } from '@udemy/ui/components/checkbox';
import type { HlsPlayerHandle } from '@udemy/ui/components/hls-player';
import { Label } from '@udemy/ui/components/label';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';

import { LecturePlayer } from '@/components/lecture-player';
import { assignLocation } from '@/lib/commerce/navigation';
import { applyCompletionState, applyProgressAck } from '@/lib/learning/cache';
import {
  completeLecture,
  fetchArticle,
  fetchDownload,
  learningKeys,
  lecturePlaylistPath,
  uncompleteLecture,
} from '@/lib/learning/client';
import { useProgressHeartbeat } from '@/lib/learning/use-progress-heartbeat';
import { problemMessage } from '@/lib/problem';

/**
 * The main pane of the player per lecture type (design §10, D4, decision P5-D2/P5-D3):
 * - VIDEO completes on the server at 90% coverage (heartbeats); no manual tick.
 * - ARTICLE completes when its end scrolls into view (`ARTICLE_READ`), or by the manual tick.
 * - RESOURCE completes on download (`RESOURCE_OPENED`), or by the manual tick.
 * QUIZ is the `QuizRunner`. In PREVIEW mode (the owner) nothing is written.
 */

export const COMPLETION_MESSAGES = {
  [ErrorCode.CompletionNotAllowed]: 'This lecture completes on its own; it cannot be ticked.',
  [ErrorCode.EnrollmentRequired]: 'Your enrollment is no longer active.',
};

function useCompletion(courseId: string, lectureId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cause: ClientCompletionCause | null) =>
      cause === null
        ? uncompleteLecture(courseId, lectureId)
        : completeLecture(courseId, lectureId, cause),
    onSuccess: (state) => applyCompletionState(queryClient, courseId, state),
  });
}

/** "Mark as complete" (ARTICLE and RESOURCE only; un-ticking is always allowed). */
export function CompletionToggle({
  courseId,
  lecture,
  disabled,
}: {
  courseId: string;
  lecture: PlayerLecture;
  disabled: boolean;
}) {
  const id = useId();
  const completion = useCompletion(courseId, lecture.id);
  if (!(MANUALLY_COMPLETABLE_LECTURE_TYPES as readonly string[]).includes(lecture.type)) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={lecture.completed}
          disabled={disabled || completion.isPending}
          onCheckedChange={(checked) => completion.mutate(checked === true ? 'MANUAL' : null)}
        />
        <Label htmlFor={id}>Mark as complete</Label>
      </div>
      {completion.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(completion.error, COMPLETION_MESSAGES)}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ video */

export function VideoLecture({
  bootstrap,
  lecture,
  startAt,
  playerRef,
}: {
  bootstrap: PlayerBootstrap;
  lecture: PlayerLecture;
  /** `?t=` from a note link; else the saved position. */
  startAt: number | null;
  playerRef: RefObject<HlsPlayerHandle | null>;
}) {
  const queryClient = useQueryClient();
  const courseId = bootstrap.courseId;
  const preview = bootstrap.mode === 'PREVIEW';
  const [playing, setPlaying] = useState(false);
  const [stopped, setStopped] = useState(false);
  const { onPlayedRanges } = useProgressHeartbeat({
    courseId,
    lectureId: lecture.id,
    enabled: !preview,
    durationSeconds: lecture.durationSeconds,
    player: playerRef,
    playing,
    onAck: (ack) => applyProgressAck(queryClient, courseId, lecture.id, ack),
    onStopped: () => setStopped(true),
  });

  const duration = lecture.durationSeconds;
  const saved = lecture.positionSeconds;
  // A finished video starts over instead of at its last second.
  const resume =
    startAt ?? (saved !== null && (duration === null || saved < duration - 5) ? saved : null);

  return (
    <div className="flex flex-col gap-3">
      <LecturePlayer
        ref={playerRef}
        src={lecturePlaylistPath(courseId, lecture.id)}
        title={lecture.title}
        startPosition={resume ?? undefined}
        onPlayedRanges={onPlayedRanges}
        onPlayingChange={setPlaying}
      />
      <p className="text-sm text-muted-foreground" data-testid="video-status">
        {preview
          ? 'Preview mode: your progress is not saved.'
          : lecture.completed
            ? 'Completed.'
            : `Watched ${lecture.coveragePct ?? 0}%. A video counts as complete once you have watched 90% of it.`}
      </p>
      {stopped ? (
        <p role="alert" className="text-sm text-destructive">
          Your progress could not be saved. Reload the page to try again.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ article */

export function ArticleLecture({
  bootstrap,
  lecture,
}: {
  bootstrap: PlayerBootstrap;
  lecture: PlayerLecture;
}) {
  const courseId = bootstrap.courseId;
  const preview = bootstrap.mode === 'PREVIEW';
  const article = useQuery({
    queryKey: learningKeys.article(courseId, lecture.id),
    queryFn: ({ signal }) => fetchArticle(courseId, lecture.id, signal),
    staleTime: 5 * 60_000,
  });
  const completion = useCompletion(courseId, lecture.id);
  const sentinel = useRef<HTMLDivElement>(null);
  const reported = useRef(false);
  const { mutate } = completion;
  const shouldWatch = article.isSuccess && !lecture.completed && !preview;

  // The end of the article came into view: it was read (once per visit).
  useEffect(() => {
    const target = sentinel.current;
    if (!shouldWatch || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (reported.current || !entries.some((entry) => entry.isIntersecting)) return;
      reported.current = true;
      observer.disconnect();
      mutate('ARTICLE_READ');
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [shouldWatch, mutate]);

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
          {problemMessage(article.error, {
            [ErrorCode.NotFound]: 'This article is not available.',
            [ErrorCode.LectureNotFound]: 'This article is not available.',
          })}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <article data-testid="article-body" className="rounded-lg border p-6">
        <MarkdownView source={article.data.bodyMd} idPrefix={`article-${lecture.id}-`} />
        <div ref={sentinel} data-testid="article-end" aria-hidden="true" className="h-px" />
      </article>
      <CompletionToggle courseId={courseId} lecture={lecture} disabled={preview} />
      {completion.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(completion.error, COMPLETION_MESSAGES)}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ resource */

export function ResourceLecture({
  bootstrap,
  lecture,
}: {
  bootstrap: PlayerBootstrap;
  lecture: PlayerLecture;
}) {
  const courseId = bootstrap.courseId;
  const preview = bootstrap.mode === 'PREVIEW';
  const completion = useCompletion(courseId, lecture.id);
  const download = useMutation({
    mutationFn: () => fetchDownload(courseId, lecture.id),
    onSuccess: (signed) => {
      if (!lecture.completed && !preview) completion.mutate('RESOURCE_OPENED');
      assignLocation(signed.url); // presigned, `Content-Disposition: attachment`
    },
  });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-3 rounded-lg border p-6">
        <p className="text-sm text-muted-foreground">This lecture is a downloadable resource.</p>
        <Button onClick={() => download.mutate()} disabled={download.isPending}>
          {download.isPending ? <Spinner className="size-4" /> : null}
          Download
        </Button>
        {download.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {problemMessage(download.error, {
              [ErrorCode.MediaNotReady]: 'This file is not available yet. Try again later.',
            })}
          </p>
        ) : null}
      </div>
      <CompletionToggle courseId={courseId} lecture={lecture} disabled={preview} />
    </div>
  );
}
