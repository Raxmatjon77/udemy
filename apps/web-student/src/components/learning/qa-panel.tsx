'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  ErrorCode,
  QA_LIMITS,
  QA_SORTS,
  type Answer,
  type PlayerBootstrap,
  type PlayerLecture,
  type QaSort,
  type Question,
  type QuestionPage,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Input } from '@udemy/ui/components/input';
import { Label } from '@udemy/ui/components/label';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Spinner } from '@udemy/ui/components/spinner';
import { Textarea } from '@udemy/ui/components/textarea';
import { useLiveRefetchInterval } from '@udemy/web-realtime';
import { useId, useMemo, useState } from 'react';

import { pluralize } from '@/lib/catalog/format';
import {
  askQuestion,
  engagementKeys,
  fetchQuestion,
  fetchQuestions,
  postAnswer,
  setAcceptedAnswer,
  setVote,
  type QuestionFilters,
} from '@/lib/engagement/client';
import { formatRelative } from '@/lib/format';
import { problemMessage } from '@/lib/problem';

import { ReportButton } from './report-dialog';

/**
 * Lecture Q&A (design D12, §10 Q&A tab): this lecture's questions or the whole course's, sorted
 * by recent activity, votes or "unanswered", searchable by title. A thread shows the answers
 * with the "Instructor" badge, votes, the accepted answer and report buttons. The course room's
 * `qa.changed` hints refresh everything under `['qa', courseId]`; without a socket the open
 * list polls.
 */

const SORT_LABELS: Record<QaSort, string> = {
  recent: 'Most recent',
  top: 'Most upvoted',
  unanswered: 'Unanswered',
};

const QA_MESSAGES = {
  [ErrorCode.MarkdownNotAllowed]: 'Use basic Markdown only (no HTML or images).',
  [ErrorCode.CannotVoteOwnContent]: 'You cannot vote for your own post.',
  [ErrorCode.EnrollmentRequired]: 'Only enrolled students can take part in the Q&A.',
};

const QA_POLL_MS = 30_000;

export function QaPanel({
  bootstrap,
  lecture,
}: {
  bootstrap: PlayerBootstrap;
  lecture: PlayerLecture;
}) {
  const courseId = bootstrap.courseId;
  const [openQuestionId, setOpenQuestionId] = useState<string | null>(null);
  if (openQuestionId) {
    return (
      <QuestionThread
        courseId={courseId}
        questionId={openQuestionId}
        onBack={() => setOpenQuestionId(null)}
      />
    );
  }
  return <QuestionList courseId={courseId} lecture={lecture} onOpen={setOpenQuestionId} />;
}

function QuestionList({
  courseId,
  lecture,
  onOpen,
}: {
  courseId: string;
  lecture: PlayerLecture;
  onOpen: (questionId: string) => void;
}) {
  const [scope, setScope] = useState<'lecture' | 'course'>('lecture');
  const [sort, setSort] = useState<QaSort>('recent');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const sortId = useId();
  const searchId = useId();
  const refetchInterval = useLiveRefetchInterval(QA_POLL_MS);

  const filters: QuestionFilters = { lectureId: scope === 'lecture' ? lecture.id : null, sort, q };
  const list = useInfiniteQuery<
    QuestionPage,
    Error,
    InfiniteData<QuestionPage, string | null>,
    ReturnType<typeof engagementKeys.questions>,
    string | null
  >({
    queryKey: engagementKeys.questions(courseId, filters),
    queryFn: ({ pageParam, signal }) => fetchQuestions(courseId, filters, pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
  });

  // The `top` sort is not stable under concurrent votes: de-duplicate pages by id (P5-D12).
  const questions = useMemo(() => {
    const seen = new Set<string>();
    const out: Question[] = [];
    for (const page of list.data?.pages ?? []) {
      for (const question of page.items) {
        if (!seen.has(question.id)) {
          seen.add(question.id);
          out.push(question);
        }
      }
    }
    return out;
  }, [list.data]);

  const searchTooShort =
    search.trim().length > 0 && search.trim().length < QA_LIMITS.searchMinChars;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Questions about" className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={scope === 'lecture' ? 'secondary' : 'ghost'}
            aria-pressed={scope === 'lecture'}
            onClick={() => setScope('lecture')}
          >
            This lecture
          </Button>
          <Button
            type="button"
            size="sm"
            variant={scope === 'course' ? 'secondary' : 'ghost'}
            aria-pressed={scope === 'course'}
            onClick={() => setScope('course')}
          >
            All lectures
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={sortId} className="text-xs">
            Sort by
          </Label>
          <NativeSelect
            id={sortId}
            value={sort}
            onChange={(e) => setSort(e.target.value as QaSort)}
          >
            {QA_SORTS.map((value) => (
              <option key={value} value={value}>
                {SORT_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <form
          role="search"
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!searchTooShort) setQ(search.trim());
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={searchId} className="text-xs">
              Search questions
            </Label>
            <Input
              id={searchId}
              type="search"
              value={search}
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
              aria-invalid={searchTooShort || undefined}
            />
          </div>
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>
        <Button type="button" size="sm" className="ml-auto" onClick={() => setAsking((v) => !v)}>
          {asking ? 'Cancel' : 'Ask a question'}
        </Button>
      </div>
      {searchTooShort ? (
        <p className="text-xs text-muted-foreground">
          Type at least {QA_LIMITS.searchMinChars} characters to search.
        </p>
      ) : null}

      {asking ? (
        <AskForm
          courseId={courseId}
          lecture={lecture}
          onAsked={(question) => {
            setAsking(false);
            onOpen(question.id);
          }}
        />
      ) : null}

      {list.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading questions…
        </p>
      ) : list.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{problemMessage(list.error, QA_MESSAGES)}</AlertDescription>
        </Alert>
      ) : questions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q ? 'No questions match your search.' : 'No questions yet. Be the first to ask!'}
        </p>
      ) : (
        <ul aria-label="Questions" className="flex flex-col divide-y rounded-md border">
          {questions.map((question) => (
            <li key={question.id} data-testid="question-row" className="flex gap-3 p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <button
                  type="button"
                  className="text-left font-medium hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  onClick={() => onOpen(question.id)}
                >
                  {question.title ?? '[deleted]'}
                </button>
                <AuthorLine post={question} />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                <span>{pluralize(question.upvoteCount, 'vote')}</span>
                <span>{pluralize(question.answerCount, 'answer')}</span>
                {question.resolved ? <Badge variant="outline">Resolved</Badge> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Load more questions
        </Button>
      ) : null}
    </div>
  );
}

function AuthorLine({
  post,
}: {
  post: Pick<Question, 'author' | 'byInstructor' | 'createdAt' | 'hidden'>;
}) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{post.author?.displayName ?? 'Former student'}</span>
      {post.byInstructor ? <Badge data-testid="instructor-badge">Instructor</Badge> : null}
      <span aria-hidden="true">·</span>
      <time dateTime={post.createdAt}>{formatRelative(post.createdAt)}</time>
      {post.hidden ? <Badge variant="destructive">Hidden by moderation</Badge> : null}
    </p>
  );
}

function AskForm({
  courseId,
  lecture,
  onAsked,
}: {
  courseId: string;
  lecture: PlayerLecture;
  onAsked: (question: Question) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [aboutLecture, setAboutLecture] = useState(true);
  const titleId = useId();
  const bodyId = useId();
  const aboutId = useId();
  const ask = useMutation({
    mutationFn: () =>
      askQuestion(courseId, {
        lectureId: aboutLecture ? lecture.id : null,
        title: title.trim(),
        bodyMd: body.trim(),
      }),
    onSuccess: (question) => {
      void queryClient.invalidateQueries({ queryKey: engagementKeys.qa(courseId) });
      onAsked(question);
    },
  });
  const valid = title.trim().length >= QA_LIMITS.titleMinChars && body.trim().length > 0;
  return (
    <form
      aria-label="Ask a question"
      className="flex flex-col gap-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) ask.mutate();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={title}
          maxLength={QA_LIMITS.titleMaxChars}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={bodyId}>Details (Markdown)</Label>
        <Textarea
          id={bodyId}
          value={body}
          rows={4}
          maxLength={QA_LIMITS.bodyMaxChars}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <label htmlFor={aboutId} className="flex items-center gap-2 text-sm">
        <input
          id={aboutId}
          type="checkbox"
          checked={aboutLecture}
          onChange={(event) => setAboutLecture(event.target.checked)}
          className="size-4 accent-primary"
        />
        About this lecture ({lecture.title})
      </label>
      {ask.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(ask.error, QA_MESSAGES)}
        </p>
      ) : null}
      <Button type="submit" className="self-start" disabled={!valid || ask.isPending}>
        Post question
      </Button>
    </form>
  );
}

function VoteButton({
  voted,
  count,
  mine,
  label,
  onToggle,
  pending,
}: {
  voted: boolean;
  count: number;
  mine: boolean;
  label: string;
  onToggle: () => void;
  pending: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={voted ? 'secondary' : 'outline'}
      aria-pressed={voted}
      aria-label={`Upvote ${label} (${count})`}
      disabled={mine || pending}
      title={mine ? 'You cannot vote for your own post' : undefined}
      onClick={onToggle}
    >
      ▲ {count}
    </Button>
  );
}

function QuestionThread({
  courseId,
  questionId,
  onBack,
}: {
  courseId: string;
  questionId: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const refetchInterval = useLiveRefetchInterval(QA_POLL_MS);
  const key = engagementKeys.question(courseId, questionId);
  const thread = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchQuestion(courseId, questionId, signal),
    refetchInterval,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: engagementKeys.qa(courseId) });

  const vote = useMutation({
    mutationFn: (input: { subject: 'questions' | 'answers'; id: string; on: boolean }) =>
      setVote(courseId, input.subject, input.id, input.on),
    onSettled: () => void refresh(),
  });
  const accept = useMutation({
    mutationFn: (answerId: string | null) => setAcceptedAnswer(courseId, questionId, answerId),
    onSettled: () => void refresh(),
  });
  const [answer, setAnswer] = useState('');
  const answerId = useId();
  const post = useMutation({
    mutationFn: () => postAnswer(courseId, questionId, answer.trim()),
    onSuccess: () => {
      setAnswer('');
      void refresh();
    },
  });

  if (thread.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the question…
      </p>
    );
  }
  if (thread.isError) {
    return (
      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
          ← All questions
        </Button>
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {problemMessage(thread.error, {
              ...QA_MESSAGES,
              [ErrorCode.QuestionNotFound]: 'This question is no longer available.',
            })}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const question = thread.data;
  const answers = question.answers.items;
  const error = vote.error ?? accept.error;

  return (
    <article aria-labelledby={`q-${question.id}`} className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        ← All questions
      </Button>
      <header className="flex flex-col gap-2">
        <h3 id={`q-${question.id}`} className="text-lg font-semibold">
          {question.title ?? '[deleted]'}
        </h3>
        <AuthorLine post={question} />
      </header>
      {question.bodyMd !== null ? (
        <MarkdownView source={question.bodyMd} idPrefix={`q-${question.id}-`} />
      ) : null}
      <div className="flex items-center gap-2">
        <VoteButton
          voted={question.voted}
          count={question.upvoteCount}
          mine={question.mine}
          label="question"
          pending={vote.isPending}
          onToggle={() =>
            vote.mutate({ subject: 'questions', id: question.id, on: !question.voted })
          }
        />
        {!question.mine && !question.deleted ? (
          <ReportButton type="QUESTION" subjectId={question.id} />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(error, QA_MESSAGES)}
        </p>
      ) : null}

      <section aria-label="Answers" className="flex flex-col gap-3">
        <h4 className="font-semibold">{pluralize(question.answerCount, 'answer')}</h4>
        <ul className="flex flex-col gap-3">
          {answers.map((item) => (
            <AnswerItem
              key={item.id}
              answer={item}
              canAccept={question.mine}
              pending={vote.isPending || accept.isPending}
              onVote={() => vote.mutate({ subject: 'answers', id: item.id, on: !item.voted })}
              onAccept={() => accept.mutate(item.accepted ? null : item.id)}
            />
          ))}
        </ul>
        {question.answers.nextCursor ? (
          <p className="text-xs text-muted-foreground">Older answers are not shown.</p>
        ) : null}
      </section>

      {!question.deleted ? (
        <form
          aria-label="Your answer"
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim()) post.mutate();
          }}
        >
          <Label htmlFor={answerId}>Your answer (Markdown)</Label>
          <Textarea
            id={answerId}
            value={answer}
            rows={3}
            maxLength={QA_LIMITS.bodyMaxChars}
            onChange={(event) => setAnswer(event.target.value)}
          />
          {post.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {problemMessage(post.error, QA_MESSAGES)}
            </p>
          ) : null}
          <Button
            type="submit"
            size="sm"
            className="self-start"
            disabled={post.isPending || !answer.trim()}
          >
            {post.isPending ? <Spinner className="size-4" /> : null}
            Post answer
          </Button>
        </form>
      ) : null}
    </article>
  );
}

function AnswerItem({
  answer,
  canAccept,
  pending,
  onVote,
  onAccept,
}: {
  answer: Answer;
  canAccept: boolean;
  pending: boolean;
  onVote: () => void;
  onAccept: () => void;
}) {
  return (
    <li
      data-testid="answer"
      data-accepted={answer.accepted || undefined}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <AuthorLine post={answer} />
        {answer.accepted ? <Badge variant="secondary">Accepted answer</Badge> : null}
      </div>
      {answer.bodyMd !== null ? (
        <MarkdownView source={answer.bodyMd} idPrefix={`a-${answer.id}-`} />
      ) : (
        <p className="text-sm text-muted-foreground">[deleted]</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <VoteButton
          voted={answer.voted}
          count={answer.upvoteCount}
          mine={answer.mine}
          label="answer"
          pending={pending}
          onToggle={onVote}
        />
        {canAccept && !answer.deleted ? (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onAccept}>
            {answer.accepted ? 'Unaccept' : 'Accept answer'}
          </Button>
        ) : null}
        {!answer.mine && !answer.deleted ? (
          <ReportButton type="ANSWER" subjectId={answer.id} />
        ) : null}
      </div>
    </li>
  );
}
