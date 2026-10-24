'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorCode, type PlayerBootstrap, type PlayerLecture } from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import type { HlsPlayerHandle } from '@udemy/ui/components/hls-player';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@udemy/ui/components/tabs';
import { useCourseRoom, useRealtimeEvent, useRealtimeStatus } from '@udemy/web-realtime';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type RefObject } from 'react';

import { LECTURE_TYPE_LABELS } from '@/lib/catalog/format';
import { courseHref } from '@/lib/commerce/links';
import { allLectures } from '@/lib/learning/cache';
import { fetchPlayerBootstrap, learningKeys } from '@/lib/learning/client';
import { certificateHref, lectureHref } from '@/lib/learning/links';
import { hasCode, problemMessage } from '@/lib/problem';

import { AnnouncementsPanel } from './announcements-panel';
import { CurriculumSidebar } from './curriculum-sidebar';
import { ArticleLecture, ResourceLecture, VideoLecture } from './lecture-content';
import { NotesPanel } from './notes-panel';
import { QaPanel } from './qa-panel';
import { QuizRunner } from './quiz-runner';
import { RatingButton } from './rating-dialog';

/**
 * `/learn/{courseId}[/{lectureId}]` (design §10): the course player.
 *
 * One bootstrap (`GET /me/courses/:courseId/learn`) drives everything: the curriculum with
 * ticks and the % bar, the resume lecture and position, the course completion and the
 * certificate. Writes (heartbeats, ticks, quiz submits) update it in place. PREVIEW mode (the
 * owner) shows the content but writes nothing. The course room (`c:{courseId}`) brings live
 * Q&A hints; a completed course waits for its certificate (WS `CERTIFICATE_ISSUED`, or polling
 * every 3 s for up to a minute).
 */

const CERTIFICATE_POLL_MS = 3_000;
const CERTIFICATE_POLL_LIMIT_MS = 60_000;

export function CoursePlayer({
  courseId,
  lectureId,
  startAt = null,
}: {
  courseId: string;
  /** From the URL; null opens the resume lecture. */
  lectureId: string | null;
  /** `?t=` seconds (a note's timestamp). */
  startAt?: number | null;
}) {
  const queryClient = useQueryClient();
  const realtime = useRealtimeStatus();
  const [waitStartedAt] = useState(() => Date.now());

  const bootstrap = useQuery({
    queryKey: learningKeys.bootstrap(courseId),
    queryFn: ({ signal }) => fetchPlayerBootstrap(courseId, signal),
    staleTime: 30_000,
    // Completed, certificate not issued yet: poll unless the socket will tell us.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.completedAt === null || data.certificate !== null) return false;
      if (realtime === 'connected') return false;
      return Date.now() - waitStartedAt < CERTIFICATE_POLL_LIMIT_MS ? CERTIFICATE_POLL_MS : false;
    },
  });

  useCourseRoom(bootstrap.isSuccess ? courseId : null);
  useRealtimeEvent('notification.created', (event) => {
    if (event.kind === 'CERTIFICATE_ISSUED') {
      void queryClient.invalidateQueries({ queryKey: learningKeys.bootstrap(courseId) });
    }
  });

  if (bootstrap.isPending) {
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]" aria-busy="true">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-96" />
        <span role="status" className="sr-only">
          Loading the course…
        </span>
      </div>
    );
  }
  if (bootstrap.isError) {
    const notEnrolled = hasCode(bootstrap.error, ErrorCode.EnrollmentRequired);
    return (
      <Alert variant={notEnrolled ? 'default' : 'destructive'} role="alert">
        <AlertTitle>
          {notEnrolled ? 'You are not enrolled in this course' : 'This course could not be opened'}
        </AlertTitle>
        <AlertDescription>
          <p>
            {notEnrolled
              ? 'Enroll in the course to watch its lectures. If you were refunded, your progress and notes are kept for when you come back.'
              : problemMessage(bootstrap.error, {
                  [ErrorCode.CourseNotFound]:
                    'This course does not exist or is no longer available.',
                })}
          </p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href="/my-learning">Back to my learning</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return <PlayerLayout bootstrap={bootstrap.data} lectureId={lectureId} startAt={startAt} />;
}

function PlayerLayout({
  bootstrap,
  lectureId,
  startAt,
}: {
  bootstrap: PlayerBootstrap;
  lectureId: string | null;
  startAt: number | null;
}) {
  const router = useRouter();
  const playerRef = useRef<HlsPlayerHandle>(null);
  const lectures = allLectures(bootstrap);
  const lecture =
    lectures.find((l) => l.id === lectureId) ??
    lectures.find((l) => l.id === bootstrap.resume?.lectureId) ??
    lectures[0];
  const preview = bootstrap.mode === 'PREVIEW';

  if (!lecture) {
    return (
      <Alert role="alert">
        <AlertDescription>This course has no lectures yet.</AlertDescription>
      </Alert>
    );
  }
  const unknownLecture = lectureId !== null && lecture.id !== lectureId;
  const index = lectures.indexOf(lecture);
  const previous = lectures[index - 1];
  const next = lectures[index + 1];
  // Resume where the bootstrap says, only for the resume lecture opened without `?t=`.
  const resumeAt =
    startAt ??
    (bootstrap.resume?.lectureId === lecture.id ? bootstrap.resume.positionSeconds : null);

  function seek(targetLectureId: string, seconds: number) {
    if (targetLectureId === lecture!.id && playerRef.current) playerRef.current.seek(seconds);
    else router.push(lectureHref(bootstrap.courseId, targetLectureId, seconds));
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={courseHref(bootstrap.slug)} className="hover:underline">
              {bootstrap.title}
            </Link>
            {bootstrap.instructor ? ` · ${bootstrap.instructor.displayName}` : null}
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{lecture.title}</h1>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{LECTURE_TYPE_LABELS[lecture.type]}</Badge>
            {bootstrap.status === 'ARCHIVED' ? <Badge variant="secondary">Archived</Badge> : null}
            {lecture.completed ? <Badge>Completed</Badge> : null}
          </p>
        </div>
        <RatingButton courseId={bootstrap.courseId} disabled={preview} />
      </header>

      {preview ? (
        <Alert role="note">
          <AlertDescription>
            Preview mode: you own this course, so your progress, notes and quiz attempts are not
            saved.
          </AlertDescription>
        </Alert>
      ) : null}
      {unknownLecture ? (
        <Alert role="note">
          <AlertDescription>
            That lecture is no longer part of this course; here is where you left off.
          </AlertDescription>
        </Alert>
      ) : null}
      <CompletionBanner bootstrap={bootstrap} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label="Lecture">
            <LectureBody
              key={lecture.id}
              bootstrap={bootstrap}
              lecture={lecture}
              startAt={resumeAt}
              playerRef={playerRef}
            />
          </section>
          <nav aria-label="Lecture navigation" className="flex justify-between gap-2">
            {previous ? (
              <Button asChild variant="outline" size="sm">
                <Link href={lectureHref(bootstrap.courseId, previous.id)}>← Previous</Link>
              </Button>
            ) : (
              <span />
            )}
            {next ? (
              <Button asChild size="sm">
                <Link href={lectureHref(bootstrap.courseId, next.id)}>Next →</Link>
              </Button>
            ) : null}
          </nav>

          <Tabs defaultValue="qa">
            <TabsList aria-label="Lecture tools">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="qa">Q&amp;A</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
              <TabsTrigger value="announcements">Announcements</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="flex flex-col gap-2 text-sm">
              <p>
                <span className="font-medium">{bootstrap.title}</span>
                {bootstrap.instructor ? ` by ${bootstrap.instructor.displayName}` : ''}
              </p>
              <p className="text-muted-foreground">
                {bootstrap.progress.completed} of {bootstrap.progress.total} lectures complete.
              </p>
              <Link href={courseHref(bootstrap.slug)} className="text-primary hover:underline">
                Course page
              </Link>
            </TabsContent>
            <TabsContent value="qa">
              <QaPanel key={lecture.id} bootstrap={bootstrap} lecture={lecture} />
            </TabsContent>
            <TabsContent value="notes">
              <NotesPanel
                bootstrap={bootstrap}
                lecture={lecture}
                currentTime={() => playerRef.current?.currentTime() ?? null}
                onSeek={seek}
              />
            </TabsContent>
            <TabsContent value="announcements">
              <AnnouncementsPanel courseId={bootstrap.courseId} />
            </TabsContent>
          </Tabs>
        </div>
        <aside className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto">
          <CurriculumSidebar bootstrap={bootstrap} currentLectureId={lecture.id} />
        </aside>
      </div>
    </div>
  );
}

function LectureBody({
  bootstrap,
  lecture,
  startAt,
  playerRef,
}: {
  bootstrap: PlayerBootstrap;
  lecture: PlayerLecture;
  startAt: number | null;
  playerRef: RefObject<HlsPlayerHandle | null>;
}) {
  switch (lecture.type) {
    case 'VIDEO':
      return (
        <VideoLecture
          bootstrap={bootstrap}
          lecture={lecture}
          startAt={startAt}
          playerRef={playerRef}
        />
      );
    case 'ARTICLE':
      return <ArticleLecture bootstrap={bootstrap} lecture={lecture} />;
    case 'RESOURCE':
      return <ResourceLecture bootstrap={bootstrap} lecture={lecture} />;
    case 'QUIZ':
      return <QuizRunner bootstrap={bootstrap} lecture={lecture} />;
  }
}

function CompletionBanner({ bootstrap }: { bootstrap: PlayerBootstrap }) {
  if (bootstrap.completedAt === null) return null;
  const certificate = bootstrap.certificate;
  return (
    <Alert role="status" data-testid="course-complete">
      <AlertTitle>Course complete!</AlertTitle>
      <AlertDescription>
        {certificate === null ? (
          <p>Your certificate is being prepared. This takes a moment.</p>
        ) : certificate.status === 'REVOKED' ? (
          <p>Your certificate for this course was revoked.</p>
        ) : (
          <p>
            Congratulations!{' '}
            <Link href={certificateHref(certificate.code)} className="font-medium underline">
              View your certificate
            </Link>
          </p>
        )}
        {bootstrap.newContent ? (
          <p className="mt-1">New lectures were added since you finished.</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
