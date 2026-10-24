'use client';

import { useId, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ANNOUNCEMENT_LIMITS,
  AnnouncementBodySchema,
  AnnouncementLimitProblemSchema,
  AnnouncementTitleSchema,
  ErrorCode,
  type Announcement,
  type AnnouncementQuota,
  type CourseDetail,
  type PostAnnouncementRequest,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Input } from '@udemy/ui/components/input';
import { Label } from '@udemy/ui/components/label';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { MarkdownEditor } from '@/components/markdown-editor';
import { QueryError } from '@/components/query-error';
import { engagementApi, engagementKeys } from '@/lib/engagement-api';
import { formatDateTime } from '@/lib/format';
import { markdownIssues, type MarkdownIssueView } from '@/lib/markdown-issues';
import { hasCode, isApiError, problemMessage } from '@/lib/problem';
import { friendlyZodError } from '@/lib/zod-messages';

/** `retryAt` of a 422 `announcement_limit_exceeded` (`AnnouncementLimitProblem`), or null. */
export function announcementRetryAt(error: unknown): string | null {
  if (!isApiError(error) || error.code !== ErrorCode.AnnouncementLimitExceeded) return null;
  const parsed = AnnouncementLimitProblemSchema.safeParse(error.problem);
  return parsed.success ? parsed.data.retryAt : null;
}

function quotaText(quota: AnnouncementQuota): string {
  return `${quota.used} of ${quota.limit} announcements used in the last ${quota.windowDays} days.`;
}

/**
 * Course announcements (Phase 5 design D18, §10 "Announcements (compose with markdown preview,
 * quota left)"): at most 4 per course per 30 days (deleted ones still count) and immutable once
 * posted, so the only change is deleting one. Posting needs a published (or archived) course.
 * A 422 `announcement_limit_exceeded` carries `retryAt`, when the next post is allowed.
 */
export function AnnouncementsTab({ course }: { course: CourseDetail }) {
  const courseId = course.id;
  const announcements = useInfiniteQuery({
    queryKey: engagementKeys.announcements(courseId),
    queryFn: ({ pageParam }) => engagementApi.announcements(courseId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const quota = announcements.data?.pages[0]?.quota;
  const items = announcements.data?.pages.flatMap((page) => page.items) ?? [];
  const postable = course.status === 'PUBLISHED' || course.status === 'ARCHIVED';

  return (
    <section aria-labelledby="announcements-heading" className="grid gap-6">
      <div className="grid gap-1">
        <h2 id="announcements-heading" className="text-xl font-semibold">
          Announcements
        </h2>
        <p className="text-sm text-muted-foreground">
          Announcements reach every enrolled student in the course and, if you choose, by email.
          They cannot be edited after posting.
        </p>
      </div>

      {announcements.isPending ? (
        <div aria-busy="true" aria-label="Loading announcements" className="grid gap-3">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : announcements.isError ? (
        <QueryError error={announcements.error} onRetry={() => void announcements.refetch()} />
      ) : (
        <>
          {quota ? <QuotaNotice quota={quota} /> : null}
          {!postable ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              You can post announcements once the course is published.
            </p>
          ) : quota && quota.nextAvailableAt === null ? (
            <ComposeForm courseId={courseId} />
          ) : null}

          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No announcements yet.</p>
          ) : (
            <ul className="grid gap-4" aria-label="Posted announcements">
              {items.map((announcement) => (
                <AnnouncementItem
                  key={announcement.id}
                  courseId={courseId}
                  announcement={announcement}
                />
              ))}
            </ul>
          )}
          {announcements.hasNextPage ? (
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={announcements.isFetchingNextPage}
                onClick={() => void announcements.fetchNextPage()}
              >
                {announcements.isFetchingNextPage ? 'Loading…' : 'Load more announcements'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function QuotaNotice({ quota }: { quota: AnnouncementQuota }) {
  if (quota.nextAvailableAt !== null) {
    return (
      <Alert role="status">
        <AlertTitle>Announcement limit reached</AlertTitle>
        <AlertDescription>
          <p>
            {quotaText(quota)} You can post the next one on{' '}
            <time dateTime={quota.nextAvailableAt}>{formatDateTime(quota.nextAvailableAt)}</time>.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {quotaText(quota)} {quota.limit - quota.used} left.
    </p>
  );
}

function ComposeForm({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const base = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; body?: string; form?: string }>({});
  const [issues, setIssues] = useState<MarkdownIssueView[] | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: engagementKeys.announcements(courseId) });

  const post = useMutation({
    mutationFn: (input: PostAnnouncementRequest) => engagementApi.postAnnouncement(courseId, input),
    onSuccess: (announcement) => {
      setTitle('');
      setBody('');
      setSendEmail(false);
      setPosted(`Posted “${announcement.title}”.`);
      void refresh();
    },
    onError: (error) => {
      const retryAt = announcementRetryAt(error);
      const found = markdownIssues(error, 'bodyMd');
      setIssues(found);
      if (retryAt) {
        setErrors({
          form: `This course has reached its limit of ${ANNOUNCEMENT_LIMITS.perCourse} announcements in ${ANNOUNCEMENT_LIMITS.windowDays} days. You can post again on ${formatDateTime(retryAt)}.`,
        });
        void refresh();
      } else {
        setErrors(found ? {} : { form: problemMessage(error) });
      }
      if (hasCode(error, ErrorCode.CourseNotFound)) void refresh();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setPosted(null);
    const next: typeof errors = {};
    const parsedTitle = AnnouncementTitleSchema.safeParse(title, { error: friendlyZodError });
    if (!parsedTitle.success) next.title = parsedTitle.error.issues[0]?.message ?? 'Invalid';
    const parsedBody = AnnouncementBodySchema.safeParse(body, { error: friendlyZodError });
    if (!parsedBody.success) next.body = parsedBody.error.issues[0]?.message ?? 'Invalid';
    setErrors(next);
    setIssues(null);
    if (!parsedTitle.success || !parsedBody.success) return;
    post.mutate({ title: parsedTitle.data, bodyMd: parsedBody.data, sendEmail });
  }

  const titleId = `${base}-title`;
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="New announcement"
      className="grid gap-4 rounded-lg border p-4"
    >
      <h3 className="font-medium">New announcement</h3>
      {errors.form ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.form}
        </p>
      ) : null}
      <div className="grid gap-1">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={ANNOUNCEMENT_LIMITS.titleMaxChars}
          aria-invalid={Boolean(errors.title)}
          aria-describedby={errors.title ? `${titleId}-error` : undefined}
        />
        {errors.title ? (
          <p id={`${titleId}-error`} className="text-sm text-destructive">
            {errors.title}
          </p>
        ) : null}
      </div>
      <MarkdownEditor
        id={`${base}-body`}
        label="Message"
        value={body}
        onChange={setBody}
        error={errors.body}
        issues={issues}
        maxLength={ANNOUNCEMENT_LIMITS.bodyMaxChars}
        rows={8}
        description="Markdown: headings, lists, code and links. No HTML or images. The preview shows what students will see."
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={sendEmail}
          onChange={(event) => setSendEmail(event.target.checked)}
        />
        Also email it to enrolled students (who did not turn announcement emails off)
      </label>
      <div className="flex items-center gap-4">
        <Button type="submit" disabled={post.isPending}>
          {post.isPending ? 'Posting…' : 'Post announcement'}
        </Button>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {posted}
        </p>
      </div>
    </form>
  );
}

function AnnouncementItem({
  courseId,
  announcement,
}: {
  courseId: string;
  announcement: Announcement;
}) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: engagementKeys.announcements(courseId) });
  return (
    <li aria-labelledby={headingId} className="grid gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="font-medium">
          {announcement.title}
        </h3>
        {announcement.sendEmail ? <Badge variant="secondary">Emailed</Badge> : null}
        <span className="text-xs text-muted-foreground">
          <time dateTime={announcement.createdAt}>{formatDateTime(announcement.createdAt)}</time>
        </span>
        <div className="ml-auto">
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Delete announcement “${announcement.title}”`}
              >
                Delete
              </Button>
            }
            title="Delete this announcement?"
            description="Students no longer see it. It still counts toward the limit of 4 announcements in 30 days."
            confirmLabel="Delete announcement"
            pendingLabel="Deleting…"
            onConfirm={async () => {
              try {
                await engagementApi.deleteAnnouncement(courseId, announcement.id);
              } catch (error) {
                if (hasCode(error, ErrorCode.AnnouncementNotFound)) void refresh();
                throw error;
              }
              await refresh();
            }}
          />
        </div>
      </div>
      <MarkdownView
        source={announcement.bodyMd}
        idPrefix={`announcement-${announcement.id}-`}
        className="text-sm"
      />
    </li>
  );
}
