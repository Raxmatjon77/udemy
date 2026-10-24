'use client';

import { useId, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  INSTRUCTOR_QA_STATUSES,
  QaBodySchema,
  QA_LIMITS,
  type Answer,
  type InstructorQaItem,
  type InstructorQaStatus,
  type Question,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Label } from '@udemy/ui/components/label';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { MarkdownEditor } from '@/components/markdown-editor';
import { QueryError } from '@/components/query-error';
import { catalogApi } from '@/lib/catalog-api';
import { engagementApi, engagementKeys } from '@/lib/engagement-api';
import { formatDateTime } from '@/lib/format';
import { markdownIssues, type MarkdownIssueView } from '@/lib/markdown-issues';
import { hasCode, problemMessage } from '@/lib/problem';
import { friendlyZodError } from '@/lib/zod-messages';

export const QA_STATUS_LABELS: Readonly<Record<InstructorQaStatus, string>> = {
  unanswered: 'Unanswered',
  unresolved: 'No accepted answer',
  all: 'All questions',
};

/** Courses that can have Q&A: published (or archived, for enrolled students). */
function useQaCourses() {
  return useQuery({
    queryKey: ['instructor', 'courses', 'qa-filter'] as const,
    queryFn: () => catalogApi.myCourses({ cursor: null }),
    select: (page) => page.items.filter((c) => c.status === 'PUBLISHED' || c.status === 'ARCHIVED'),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * The instructor's Q&A inbox (Phase 5 design §10 "/qa inbox"): questions on the instructor's
 * own courses, unanswered first (the default filter), newest activity first. A question opens
 * in place with its answers; the instructor answers (marked "Instructor" for students) and can
 * accept an answer (or remove the acceptance) as the course owner.
 */
export function QaInbox({
  initialCourseId,
  initialStatus = 'unanswered',
}: {
  initialCourseId?: string | undefined;
  initialStatus?: InstructorQaStatus;
}) {
  const [courseId, setCourseId] = useState<string | undefined>(initialCourseId);
  const [status, setStatus] = useState<InstructorQaStatus>(initialStatus);
  const courses = useQaCourses();
  const inbox = useInfiniteQuery({
    queryKey: engagementKeys.qaInbox(courseId, status),
    queryFn: ({ pageParam }) => engagementApi.inbox({ courseId, status, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });
  const items = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  // `top`-style pages can repeat an item under concurrent activity: de-duplicate by id (P5-D12).
  const unique = [...new Map(items.map((item) => [item.question.id, item])).values()];

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Questions &amp; answers</h1>
        <p className="text-muted-foreground">
          Questions students asked in your courses. Your answers carry an “Instructor” badge.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1">
          <Label htmlFor="qa-course">Course</Label>
          <NativeSelect
            id="qa-course"
            value={courseId ?? ''}
            onChange={(event) => setCourseId(event.target.value || undefined)}
            className="w-72"
          >
            <option value="">All courses</option>
            {courseId && !courses.data?.some((c) => c.id === courseId) ? (
              <option value={courseId}>This course</option>
            ) : null}
            {courses.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="qa-status">Show</Label>
          <NativeSelect
            id="qa-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as InstructorQaStatus)}
            className="w-56"
          >
            {INSTRUCTOR_QA_STATUSES.map((value) => (
              <option key={value} value={value}>
                {QA_STATUS_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {inbox.isPending ? (
        <div aria-busy="true" aria-label="Loading questions" className="grid gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : inbox.isError ? (
        <QueryError error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : unique.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-muted-foreground">
          {status === 'unanswered'
            ? 'No unanswered questions. Nice work!'
            : status === 'unresolved'
              ? 'Every question has an accepted answer.'
              : 'No questions yet.'}
        </p>
      ) : (
        <ul className="grid gap-4" aria-label="Questions">
          {unique.map((item) => (
            <QuestionItem key={item.question.id} item={item} />
          ))}
        </ul>
      )}
      {inbox.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={inbox.isFetchingNextPage}
            onClick={() => void inbox.fetchNextPage()}
          >
            {inbox.isFetchingNextPage ? 'Loading…' : 'Load more questions'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function authorName(person: { displayName: string } | null): string {
  return person?.displayName ?? 'Former student';
}

function QuestionItem({ item }: { item: InstructorQaItem }) {
  const { question, course, lectureTitle } = item;
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const panelId = useId();
  const title = question.title ?? '[deleted]';
  return (
    <li aria-labelledby={headingId} className="grid gap-3 rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">
        {course.title} · {lectureTitle ?? 'General question'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="font-semibold">
          {title}
        </h2>
        {question.resolved ? <Badge variant="secondary">Answer accepted</Badge> : null}
        <Badge variant="outline">
          {question.answerCount} answer{question.answerCount === 1 ? '' : 's'}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Asked by {authorName(question.author)} ·{' '}
        <time dateTime={question.createdAt}>{formatDateTime(question.createdAt)}</time>
        {' · '}
        {question.upvoteCount} upvote{question.upvoteCount === 1 ? '' : 's'}
      </p>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          aria-label={`${open ? 'Close' : 'Open'} question “${title}”`}
        >
          {open ? 'Close' : 'Open and answer'}
        </Button>
      </div>
      <div id={panelId} hidden={!open}>
        {open ? <QuestionThread courseId={course.id} questionId={question.id} /> : null}
      </div>
    </li>
  );
}

function QuestionThread({ courseId, questionId }: { courseId: string; questionId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const question = useQuery({
    queryKey: engagementKeys.question(courseId, questionId),
    queryFn: () => engagementApi.question(courseId, questionId),
    staleTime: 0,
  });
  const answers = useInfiniteQuery({
    queryKey: engagementKeys.answers(courseId, questionId),
    queryFn: ({ pageParam }) => engagementApi.answers(courseId, questionId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['qa', courseId, 'question', questionId] });
    void queryClient.invalidateQueries({ queryKey: ['qa', 'inbox'] });
  };
  const onError = (error: unknown) => {
    setNotice(problemMessage(error));
    if (hasCode(error, ErrorCode.AnswerNotFound) || hasCode(error, ErrorCode.QuestionNotFound)) {
      refresh();
    }
  };
  const accept = useMutation({
    mutationFn: (answerId: string) => engagementApi.accept(courseId, questionId, answerId),
    onSuccess: () => {
      setNotice(null);
      refresh();
    },
    onError,
  });
  const unaccept = useMutation({
    mutationFn: () => engagementApi.unaccept(courseId, questionId),
    onSuccess: () => {
      setNotice(null);
      refresh();
    },
    onError,
  });

  if (question.isPending) {
    return <Skeleton aria-label="Loading the question" className="h-32 w-full" />;
  }
  if (question.isError) {
    return <QueryError error={question.error} onRetry={() => void question.refetch()} />;
  }
  const q: Question = question.data;
  const list = answers.data?.pages.flatMap((page) => page.items) ?? [];
  const busy = accept.isPending || unaccept.isPending;

  return (
    <div className="grid gap-4 border-t pt-4">
      {q.bodyMd ? (
        <MarkdownView source={q.bodyMd} idPrefix={`question-${q.id}-`} className="text-sm" />
      ) : (
        <p className="text-sm text-muted-foreground">The author deleted this question.</p>
      )}
      <div role="alert" aria-live="assertive">
        {notice ? <p className="text-sm text-destructive">{notice}</p> : null}
      </div>

      <section aria-label="Answers" className="grid gap-3">
        <h3 className="text-sm font-semibold">Answers</h3>
        {answers.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : answers.isError ? (
          <QueryError error={answers.error} onRetry={() => void answers.refetch()} />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No answers yet. Be the first to answer.</p>
        ) : (
          <ol className="grid gap-3">
            {list.map((answer) => (
              <AnswerItem
                key={answer.id}
                answer={answer}
                canAccept={!q.deleted}
                busy={busy}
                onAccept={() => accept.mutate(answer.id)}
                onUnaccept={() => unaccept.mutate()}
              />
            ))}
          </ol>
        )}
        {answers.hasNextPage ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={answers.isFetchingNextPage}
              onClick={() => void answers.fetchNextPage()}
            >
              Load more answers
            </Button>
          </div>
        ) : null}
      </section>

      {q.deleted ? null : (
        <AnswerForm courseId={courseId} questionId={questionId} onPosted={refresh} />
      )}
    </div>
  );
}

function AnswerItem({
  answer,
  canAccept,
  busy,
  onAccept,
  onUnaccept,
}: {
  answer: Answer;
  canAccept: boolean;
  busy: boolean;
  onAccept: () => void;
  onUnaccept: () => void;
}) {
  const who = answer.mine ? 'You' : authorName(answer.author);
  return (
    <li
      className="grid gap-2 rounded-md border p-3"
      aria-label={`Answer by ${who}${answer.accepted ? ', accepted' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{who}</span>
        {answer.byInstructor ? <Badge>Instructor</Badge> : null}
        {answer.accepted ? <Badge variant="secondary">Accepted answer</Badge> : null}
        {answer.hidden ? <Badge variant="destructive">Hidden by moderation</Badge> : null}
        <time dateTime={answer.createdAt}>{formatDateTime(answer.createdAt)}</time>
        {answer.editedAt ? <span>· edited</span> : null}
        <span>
          · {answer.upvoteCount} upvote{answer.upvoteCount === 1 ? '' : 's'}
        </span>
      </div>
      {answer.bodyMd ? (
        <MarkdownView
          source={answer.bodyMd}
          idPrefix={`answer-${answer.id}-`}
          className="text-sm"
        />
      ) : (
        <p className="text-sm text-muted-foreground">[deleted]</p>
      )}
      {canAccept && !answer.deleted && !answer.hidden ? (
        <div>
          {answer.accepted ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onUnaccept}>
              Remove acceptance
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAccept}>
              Accept answer
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}

function AnswerForm({
  courseId,
  questionId,
  onPosted,
}: {
  courseId: string;
  questionId: string;
  onPosted: () => void;
}) {
  const id = useId();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [issues, setIssues] = useState<MarkdownIssueView[] | null>(null);
  const post = useMutation({
    mutationFn: (bodyMd: string) => engagementApi.postAnswer(courseId, questionId, bodyMd),
    onSuccess: () => {
      setBody('');
      setFormError(null);
      setIssues(null);
      onPosted();
    },
    onError: (err) => {
      const found = markdownIssues(err, 'bodyMd');
      setIssues(found);
      setFormError(found ? null : problemMessage(err));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = QaBodySchema.safeParse(body, { error: friendlyZodError });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Write an answer first.');
      return;
    }
    setError(undefined);
    post.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Your answer" className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Answering as</span>
        <Badge>Instructor</Badge>
      </div>
      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}
      <MarkdownEditor
        id={`${id}-answer`}
        label="Your answer"
        value={body}
        onChange={setBody}
        error={error}
        issues={issues}
        maxLength={QA_LIMITS.bodyMaxChars}
        rows={6}
        description="Markdown: code, lists and links. No HTML or images."
      />
      <div>
        <Button type="submit" disabled={post.isPending}>
          {post.isPending ? 'Posting…' : 'Post answer'}
        </Button>
      </div>
    </form>
  );
}
