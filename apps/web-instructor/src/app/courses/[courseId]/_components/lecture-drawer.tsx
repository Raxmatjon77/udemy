'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArticleBodySchema,
  COURSE_READINESS_RULES,
  ErrorCode,
  LectureTitleSchema,
  MEDIA_FAILURE_LABELS,
  PREVIEWABLE_LECTURE_TYPES,
  type AssetView,
  type Lecture,
  type UpdateLectureRequest,
} from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@udemy/ui/components/dialog';
import { HlsPlayer } from '@udemy/ui/components/hls-player';
import { Input } from '@udemy/ui/components/input';
import { Label } from '@udemy/ui/components/label';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { MarkdownEditor } from '@/components/markdown-editor';
import { QueryError } from '@/components/query-error';
import { SubmitButton } from '@/components/submit-button';
import { UploadField } from '@/components/upload-field';
import { catalogApi } from '@/lib/catalog-api';
import { catalogKeys, isTerminal, useAssetStatus } from '@/lib/catalog-queries';
import { formatBytes, formatDuration } from '@/lib/format';
import { LECTURE_TYPE_LABELS, MEDIA_STATUS_LABELS } from '@/lib/labels';
import { markdownIssues, type MarkdownIssueView } from '@/lib/markdown-issues';
import { hasCode, problemMessage } from '@/lib/problem';
import { friendlyZodError } from '@/lib/zod-messages';

const PREVIEWABLE: ReadonlySet<string> = new Set(PREVIEWABLE_LECTURE_TYPES);

function useRefreshCurriculum(courseId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: catalogKeys.curriculum(courseId), exact: true });
    void queryClient.invalidateQueries({ queryKey: catalogKeys.course(courseId), exact: true });
  };
}

/**
 * Lecture editor in a side drawer (design §10): title, free-preview toggle and the content of
 * the lecture type: VIDEO (upload, processing status, owner preview player), ARTICLE (markdown
 * editor with live preview) or RESOURCE (file upload).
 */
export function LectureDrawer({
  courseId,
  lecture,
  readOnly,
  onClose,
}: {
  courseId: string;
  lecture: Lecture | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={lecture !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-2xl translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none border-y-0 border-r-0 sm:max-w-2xl">
        {lecture ? <LectureEditor courseId={courseId} lecture={lecture} readOnly={readOnly} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LectureEditor({
  courseId,
  lecture,
  readOnly,
}: {
  courseId: string;
  lecture: Lecture;
  readOnly: boolean;
}) {
  return (
    <div className="grid gap-8">
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{LECTURE_TYPE_LABELS[lecture.type]}</Badge>
          {readOnly ? <Badge variant="secondary">Read-only</Badge> : null}
        </div>
        <DialogTitle>{lecture.title}</DialogTitle>
        <DialogDescription>
          {lecture.type === 'VIDEO'
            ? 'Upload the lecture video. It is processed into streaming quality levels.'
            : lecture.type === 'ARTICLE'
              ? 'Write the article in markdown. The preview shows what students will see.'
              : 'Upload a PDF or ZIP file students can download.'}
        </DialogDescription>
      </DialogHeader>
      <LectureSettings courseId={courseId} lecture={lecture} readOnly={readOnly} />
      {lecture.type === 'ARTICLE' ? (
        <ArticleEditor courseId={courseId} lecture={lecture} readOnly={readOnly} />
      ) : (
        <MediaPanel courseId={courseId} lecture={lecture} readOnly={readOnly} />
      )}
    </div>
  );
}

/* ---- title and preview ---------------------------------------------------------------- */

function LectureSettings({ courseId, lecture, readOnly }: { courseId: string; lecture: Lecture; readOnly: boolean }) {
  const refresh = useRefreshCurriculum(courseId);
  const [title, setTitle] = useState(lecture.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: UpdateLectureRequest) => catalogApi.updateLecture(courseId, lecture.id, body),
    onSuccess: refresh,
    onError: (error) => {
      if (hasCode(error, ErrorCode.CourseInReview)) refresh();
    },
  });
  const previewable = PREVIEWABLE.has(lecture.type);
  const titleId = `lecture-title-${lecture.id}`;
  const previewId = `lecture-preview-${lecture.id}`;

  function saveTitle(event: FormEvent) {
    event.preventDefault();
    const parsed = LectureTitleSchema.safeParse(title, { error: friendlyZodError });
    if (!parsed.success) {
      setTitleError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }
    setTitleError(null);
    if (parsed.data !== lecture.title) update.mutate({ title: parsed.data });
  }

  return (
    <section aria-label="Lecture settings" className="grid gap-4">
      <form onSubmit={saveTitle} noValidate className="grid gap-2">
        <Label htmlFor={titleId}>Lecture title</Label>
        <div className="flex gap-2">
          <Input
            id={titleId}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
            disabled={readOnly}
            aria-invalid={Boolean(titleError)}
            aria-describedby={titleError ? `${titleId}-error` : undefined}
          />
          {readOnly ? null : (
            <Button type="submit" variant="outline" disabled={update.isPending}>
              Save title
            </Button>
          )}
        </div>
        {titleError ? (
          <p id={`${titleId}-error`} className="text-sm text-destructive">
            {titleError}
          </p>
        ) : null}
      </form>
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <input
            id={previewId}
            type="checkbox"
            className="size-4 accent-primary"
            checked={lecture.isPreview}
            disabled={readOnly || !previewable || update.isPending}
            onChange={(event) => update.mutate({ isPreview: event.target.checked })}
            aria-describedby={`${previewId}-description`}
          />
          <Label htmlFor={previewId}>Free preview</Label>
        </div>
        <p id={`${previewId}-description`} className="text-xs text-muted-foreground">
          {previewable
            ? 'Anyone can watch or read a preview lecture on the course page (at most 10 per course).'
            : 'Resource lectures cannot be previews.'}
        </p>
      </div>
      {update.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(update.error)}
        </p>
      ) : null}
    </section>
  );
}

/* ---- video and resource --------------------------------------------------------------- */

function AssetStatus({ asset }: { asset: AssetView }) {
  return (
    <div className="grid gap-2" role="status" aria-live="polite">
      <p className="text-sm">
        <span className="font-medium">{MEDIA_STATUS_LABELS[asset.status]}</span>
        {' · '}
        <span className="text-muted-foreground">
          {asset.originalFilename} ({formatBytes(asset.sizeBytes)})
          {asset.durationSeconds !== null ? ` · ${formatDuration(asset.durationSeconds)}` : null}
        </span>
      </p>
      {asset.status === 'PROCESSING' || asset.status === 'UPLOADED' ? (
        <progress
          className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
          max={100}
          value={asset.progressPct ?? undefined}
          aria-label="Processing progress"
        >
          {asset.progressPct ?? 0}%
        </progress>
      ) : null}
      {asset.status === 'FAILED' ? (
        <Alert variant="destructive">
          <AlertTitle>Processing failed</AlertTitle>
          <AlertDescription>
            {asset.failureCode
              ? MEDIA_FAILURE_LABELS[asset.failureCode]
              : 'The file could not be processed. Upload it again.'}
          </AlertDescription>
        </Alert>
      ) : null}
      {asset.status === 'ABORTED' ? (
        <p className="text-sm text-muted-foreground">The upload was cancelled. Upload the file again.</p>
      ) : null}
    </div>
  );
}

function MediaPanel({ courseId, lecture, readOnly }: { courseId: string; lecture: Lecture; readOnly: boolean }) {
  const refresh = useRefreshCurriculum(courseId);
  const asset = useAssetStatus(lecture.asset);
  const current = lecture.asset ? (asset.data ?? lecture.asset) : null;
  const isVideo = lecture.type === 'VIDEO';
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Processing finished (or failed): refresh the lecture row, totals and readiness.
  const embedded = lecture.asset?.status;
  const live = current?.status;
  useEffect(() => {
    if (live && embedded && live !== embedded && isTerminal(live)) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable in effect
  }, [live, embedded]);

  const detach = useMutation({
    mutationFn: () => catalogApi.detachMedia(courseId, lecture.id),
    onSuccess: refresh,
  });

  async function download() {
    setDownloadError(null);
    try {
      const { url } = await catalogApi.download(courseId, lecture.id);
      window.location.assign(url);
    } catch (error) {
      setDownloadError(problemMessage(error));
    }
  }

  return (
    <section aria-label={isVideo ? 'Video' : 'Resource file'} className="grid gap-4">
      {current ? <AssetStatus asset={current} /> : null}
      {current?.status === 'UPLOADING' ? (
        <p className="text-sm text-muted-foreground">
          This upload did not finish. If it is not offered for resuming below, upload the file again.
        </p>
      ) : null}

      {isVideo && current?.status === 'READY' ? (
        <HlsPlayer
          src={catalogApi.previewPlaylistUrl(courseId, lecture.id)}
          title={lecture.title}
          className="overflow-hidden rounded-md"
        />
      ) : null}
      {!isVideo && current?.status === 'READY' ? (
        <div className="grid gap-1">
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => void download()}>
              Download file
            </Button>
          </div>
          {downloadError ? (
            <p role="alert" className="text-sm text-destructive">
              {downloadError}
            </p>
          ) : null}
        </div>
      ) : null}

      <UploadField
        purpose={isVideo ? 'LECTURE_VIDEO' : 'LECTURE_RESOURCE'}
        slotKey={`lecture:${lecture.id}`}
        label={current ? (isVideo ? 'Replace video' : 'Replace file') : isVideo ? 'Upload video' : 'Upload file'}
        description={
          isVideo
            ? 'MP4, MOV, WebM or MKV. Large files upload in parts and can resume after an interruption.'
            : 'PDF or ZIP, up to 100 MB.'
        }
        disabled={readOnly}
        onInitiated={async (assetId) => {
          await catalogApi.attachMedia(courseId, lecture.id, assetId);
          refresh();
        }}
        onComplete={() => refresh()}
      />

      {current && !readOnly ? (
        <div className="grid gap-1">
          <div>
            <Button type="button" size="sm" variant="ghost" onClick={() => detach.mutate()} disabled={detach.isPending}>
              {isVideo ? 'Remove video' : 'Remove file'}
            </Button>
          </div>
          {detach.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {problemMessage(detach.error)}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ---- article ---------------------------------------------------------------------------- */

function ArticleEditor({ courseId, lecture, readOnly }: { courseId: string; lecture: Lecture; readOnly: boolean }) {
  const article = useQuery({
    queryKey: catalogKeys.article(courseId, lecture.id),
    queryFn: () => catalogApi.article(courseId, lecture.id),
    staleTime: 0,
  });
  if (article.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading the article" className="grid gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (article.isError) {
    return <QueryError error={article.error} onRetry={() => void article.refetch()} />;
  }
  return (
    <ArticleForm
      key={lecture.id}
      courseId={courseId}
      lectureId={lecture.id}
      initial={article.data.bodyMd}
      readOnly={readOnly}
    />
  );
}

export function ArticleForm({
  courseId,
  lectureId,
  initial,
  readOnly,
}: {
  courseId: string;
  lectureId: string;
  initial: string;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const refresh = useRefreshCurriculum(courseId);
  const [body, setBody] = useState(initial);
  const [savedBody, setSavedBody] = useState(initial);
  const [issues, setIssues] = useState<MarkdownIssueView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const id = `article-${lectureId}`;

  const save = useMutation({
    mutationFn: (bodyMd: string) => catalogApi.saveArticle(courseId, lectureId, bodyMd),
    onSuccess: (article) => {
      queryClient.setQueryData(catalogKeys.article(courseId, lectureId), article);
      setSavedBody(article.bodyMd);
      setIssues(null);
      setError(null);
      setSaved('Article saved.');
      refresh();
    },
    onError: (err) => {
      setSaved(null);
      const found = markdownIssues(err, 'bodyMd');
      setIssues(found);
      setError(found ? null : problemMessage(err));
      if (hasCode(err, ErrorCode.CourseInReview)) refresh();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = ArticleBodySchema.safeParse(body, { error: friendlyZodError });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid article');
      return;
    }
    save.mutate(parsed.data);
  }

  const dirty = body !== savedBody;
  return (
    <form onSubmit={submit} noValidate className="grid gap-3" aria-label="Article">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <MarkdownEditor
        id={id}
        label="Article"
        value={body}
        onChange={(value) => {
          setBody(value);
          setSaved(null);
        }}
        disabled={readOnly}
        maxLength={100_000}
        rows={18}
        issues={issues}
        description={`Markdown: headings, lists, code, tables and http(s) links. No HTML or images. At least ${COURSE_READINESS_RULES.minArticleChars} characters before you can submit.`}
      />
      {readOnly ? null : (
        <div className="flex items-center gap-4">
          <SubmitButton pending={save.isPending} pendingLabel="Saving…" disabled={!dirty}>
            Save article
          </SubmitButton>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {saved ?? (dirty ? 'Unsaved changes' : null)}
          </p>
        </div>
      )}
    </form>
  );
}
