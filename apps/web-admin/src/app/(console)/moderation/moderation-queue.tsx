'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  ModerationQueuePageSchema,
  ModerationReasonRequestSchema,
  ModerationSubjectSchema,
  REPORT_REASON_LABELS,
  REPORT_STATUSES,
  REPORT_SUBJECT_PATHS,
  REPORT_SUBJECT_TYPES,
  type ModerationActionType,
  type ModerationQueueItem,
  type ReportStatus,
  type ReportSubjectType,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { cn } from '@udemy/ui/lib/utils';

import { LoadMore } from '@/components/load-more';
import { QueryError } from '@/components/query-error';
import { ReasonDialog } from '@/components/reason-dialog';
import { api, queryString } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

/*
 * The content moderation queue (Phase 5 design D13, §8 admin, §10 web-admin `/moderation`): one
 * item per reported review, review reply, question or answer, newest report first. Admins hide,
 * restore or dismiss the reports, always with a reason (it lands in `moderation_actions`).
 */

const PAGE_SIZE = 20;

export const SUBJECT_TYPE_LABEL: Record<ReportSubjectType, string> = {
  REVIEW: 'Review',
  REVIEW_REPLY: 'Review reply',
  QUESTION: 'Question',
  ANSWER: 'Answer',
};

const SUBJECT_TYPE_FILTER_LABEL: Record<ReportSubjectType, string> = {
  REVIEW: 'Reviews',
  REVIEW_REPLY: 'Review replies',
  QUESTION: 'Questions',
  ANSWER: 'Answers',
};

const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  OPEN: 'Open',
  ACTIONED: 'Actioned',
  DISMISSED: 'Dismissed',
};

const ACTION_LABEL: Record<ModerationActionType, string> = {
  HIDE: 'Hidden',
  RESTORE: 'Restored',
  DISMISS_REPORTS: 'Reports dismissed',
};

const EMPTY_LABEL: Record<ReportStatus, string> = {
  OPEN: 'Nothing to review: no content has open reports.',
  ACTIONED: 'No actioned reports.',
  DISMISSED: 'No dismissed reports.',
};

const ACTION_MESSAGES: MessageOverrides = {
  [ErrorCode.InvalidStateTransition]: 'This item was already moderated. The queue was refreshed.',
};

type Action = 'hide' | 'restore' | 'dismiss-reports';

function filterHref(type: ReportSubjectType | null, status: ReportStatus): string {
  return `/moderation${queryString({ type, status: status === 'OPEN' ? null : status })}`;
}

function FilterTabs({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; href: string; current: boolean }[];
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1 border-b">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              className={cn(
                '-mb-px block border-b-2 px-3 py-2 text-sm font-medium',
                item.current
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Preview({ item }: { item: ModerationQueueItem }) {
  const { preview } = item;
  return (
    <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">
        By {preview.author?.displayName ?? 'Former student'} ·{' '}
        <time dateTime={preview.createdAt}>{formatDateTime(preview.createdAt)}</time>
        {preview.rating !== null ? ` · ${preview.rating} out of 5 stars` : null}
      </p>
      {preview.deleted ? <Badge variant="outline">Deleted by the author</Badge> : null}
      {preview.title ? <p className="font-medium">{preview.title}</p> : null}
      {preview.body === null ? (
        <p className="text-sm text-muted-foreground">No text.</p>
      ) : preview.bodyIsMarkdown ? (
        <MarkdownView
          source={preview.body}
          idPrefix={`moderation-${item.subjectId}-`}
          className="text-sm"
        />
      ) : (
        <p className="text-sm whitespace-pre-line">{preview.body}</p>
      )}
    </div>
  );
}

function Reports({ item }: { item: ModerationQueueItem }) {
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-medium">Reports</h3>
      <ul className="grid gap-1 text-sm">
        {item.reports.map((report) => (
          <li key={report.id} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{REPORT_REASON_LABELS[report.reason]}</span>
            <span className="text-muted-foreground">
              by {report.reporter?.displayName ?? 'a former user'} ·{' '}
              <time dateTime={report.createdAt}>{formatDateTime(report.createdAt)}</time> ·{' '}
              {REPORT_STATUS_LABEL[report.status]}
            </span>
            {report.comment ? (
              <span className="basis-full whitespace-pre-line text-muted-foreground">
                “{report.comment}”
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function History({ item }: { item: ModerationQueueItem }) {
  if (item.actions.length === 0) return null;
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-medium">Action history</h3>
      <ol className="grid gap-1 text-sm">
        {item.actions.map((action) => (
          <li key={action.id} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{ACTION_LABEL[action.action]}</span>
            <span className="text-muted-foreground">
              {action.actor ? `by ${action.actor.displayName}` : 'Automatic (report threshold)'} ·{' '}
              <time dateTime={action.occurredAt}>{formatDateTime(action.occurredAt)}</time>
            </span>
            {action.reason ? (
              <span className="basis-full whitespace-pre-line text-muted-foreground">
                {action.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Actions({
  item,
  onDone,
}: {
  item: ModerationQueueItem;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const label = SUBJECT_TYPE_LABEL[item.subjectType].toLowerCase();
  const name = `${SUBJECT_TYPE_LABEL[item.subjectType]} in ${item.courseTitle ?? 'a deleted course'}`;
  const moderate = useMutation({
    mutationFn: ({ action, reason }: { action: Action; reason: string }) =>
      api(
        `/admin/moderation/${REPORT_SUBJECT_PATHS[item.subjectType]}/${encodeURIComponent(item.subjectId)}/${action}`,
        { method: 'POST', json: { reason }, schema: ModerationSubjectSchema },
      ),
    onSuccess: (_subject, { action }) => {
      const verb = {
        hide: 'Hid',
        restore: 'Restored',
        'dismiss-reports': 'Dismissed the reports on',
      }[action];
      onDone(`${verb} the ${label} in ${item.courseTitle ?? 'a deleted course'}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.moderation });
    },
    onError: (error) => {
      if (hasCode(error, ErrorCode.InvalidStateTransition)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.moderation });
      }
    },
  });
  const run = (action: Action) => (reason: string | undefined) =>
    moderate.mutateAsync({ action, reason: reason ?? '' });
  const hidden = item.moderationStatus === 'HIDDEN';
  const open = item.openReportCount > 0;
  const common = {
    label: 'Reason',
    fieldDescription: '10 to 2000 characters. Stored in the moderation history.',
    schema: ModerationReasonRequestSchema,
    maxLength: 2000,
    messages: ACTION_MESSAGES,
  };

  return (
    <div className="flex flex-wrap gap-2">
      {!hidden || open ? (
        <ReasonDialog
          {...common}
          trigger={
            <Button
              size="sm"
              variant="destructive"
              aria-label={`${hidden ? 'Confirm hide' : 'Hide'}: ${name}`}
            >
              {hidden ? 'Confirm hide' : 'Hide'}
            </Button>
          }
          title={hidden ? `Keep this ${label} hidden?` : `Hide this ${label}?`}
          description={
            hidden
              ? 'It was hidden automatically. Confirming closes its open reports as actioned.'
              : 'Nobody but its author sees it any more, notifications quoting it are redacted, and the author is told it was hidden.'
          }
          confirmLabel={hidden ? 'Confirm hide' : 'Hide'}
          pendingLabel="Hiding…"
          destructive
          onConfirm={run('hide')}
        />
      ) : null}
      {hidden ? (
        <ReasonDialog
          {...common}
          trigger={
            <Button size="sm" variant="outline" aria-label={`Restore: ${name}`}>
              Restore
            </Button>
          }
          title={`Restore this ${label}?`}
          description="It becomes visible again and its open reports are dismissed."
          confirmLabel="Restore"
          pendingLabel="Restoring…"
          onConfirm={run('restore')}
        />
      ) : null}
      {open ? (
        <ReasonDialog
          {...common}
          trigger={
            <Button size="sm" variant="outline" aria-label={`Dismiss reports: ${name}`}>
              Dismiss reports
            </Button>
          }
          title={`Dismiss the reports on this ${label}?`}
          description={
            hidden
              ? 'The reports are closed; the content stays hidden (use Restore to show it again).'
              : 'The reports are closed and the content stays visible.'
          }
          confirmLabel="Dismiss reports"
          pendingLabel="Dismissing…"
          onConfirm={run('dismiss-reports')}
        />
      ) : null}
    </div>
  );
}

function QueueItem({
  item,
  onDone,
}: {
  item: ModerationQueueItem;
  onDone: (message: string) => void;
}) {
  const headingId = useId();
  return (
    <li>
      <Card aria-labelledby={headingId}>
        <CardHeader>
          <CardTitle asChild>
            <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-base">
              {SUBJECT_TYPE_LABEL[item.subjectType]} in {item.courseTitle ?? 'a deleted course'}
              <Badge variant={item.moderationStatus === 'HIDDEN' ? 'destructive' : 'outline'}>
                {item.moderationStatus === 'HIDDEN' ? 'Hidden' : 'Visible'}
              </Badge>
              <Badge variant="secondary">
                {item.openReportCount} open report{item.openReportCount === 1 ? '' : 's'}
              </Badge>
            </h2>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Last reported{' '}
            <time dateTime={item.lastReportedAt}>{formatDateTime(item.lastReportedAt)}</time>
          </p>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Preview item={item} />
          <Reports item={item} />
          <History item={item} />
          <Actions item={item} onDone={onDone} />
        </CardContent>
      </Card>
    </li>
  );
}

export function ModerationQueue({
  type,
  status,
}: {
  type: ReportSubjectType | null;
  status: ReportStatus;
}) {
  const [notice, setNotice] = useState('');
  const queue = useInfiniteQuery({
    queryKey: queryKeys.moderationQueue(type, status),
    queryFn: ({ pageParam }) =>
      api(
        `/admin/moderation/reports${queryString({ type, status, cursor: pageParam, limit: PAGE_SIZE })}`,
        { schema: ModerationQueuePageSchema },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const items = queue.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="grid gap-4">
      <FilterTabs
        label="Report status"
        items={REPORT_STATUSES.map((value) => ({
          key: value,
          label: REPORT_STATUS_LABEL[value],
          href: filterHref(type, value),
          current: value === status,
        }))}
      />
      <FilterTabs
        label="Content type"
        items={[null, ...REPORT_SUBJECT_TYPES].map((value) => ({
          key: value ?? 'all',
          label: value === null ? 'All' : SUBJECT_TYPE_FILTER_LABEL[value],
          href: filterHref(value, status),
          current: value === type,
        }))}
      />
      <p role="status" aria-live="polite" className="text-sm">
        {notice}
      </p>
      {queue.isPending ? (
        <div aria-busy="true" aria-label="Loading reports" className="grid gap-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : queue.isError && items.length === 0 ? (
        <QueryError error={queue.error} onRetry={() => void queue.refetch()} />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          {EMPTY_LABEL[status]}
        </p>
      ) : (
        <>
          <ul className="grid gap-4" aria-label="Reported content">
            {items.map((item) => (
              <QueueItem
                key={`${item.subjectType}:${item.subjectId}`}
                item={item}
                onDone={setNotice}
              />
            ))}
          </ul>
          <LoadMore query={queue} count={items.length} noun={['item', 'items']} />
        </>
      )}
    </div>
  );
}
