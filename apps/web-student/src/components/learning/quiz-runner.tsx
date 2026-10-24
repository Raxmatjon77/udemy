'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  type PlayerBootstrap,
  type PlayerLecture,
  type QuizAttempt,
  type QuizAttemptQuestion,
  type QuizQuestionResult,
  type SubmitQuizAttemptResponse,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';
import { cn } from '@udemy/ui/lib/utils';
import { useState } from 'react';

import { pluralize } from '@/lib/catalog/format';
import { applyProgressAck } from '@/lib/learning/cache';
import {
  fetchQuizAttempts,
  learningKeys,
  startQuizAttempt,
  submitQuizAttempt,
} from '@/lib/learning/client';
import { problemMessage } from '@/lib/problem';

/**
 * A QUIZ lecture (design D6, §10; decision P5-D5).
 *
 * Start (or resume the open attempt), one question per screen, submit, then the result. The
 * attempt as the api serves it carries **no answer key**, so nothing here can show one before a
 * submit. The result shows, per question, whether YOUR answer was right; the correct options
 * and the explanations only when the server revealed them (`revealed`, i.e. after a pass).
 * Unlimited retries (rate-limited by the api). Passing completes the lecture on the server.
 */

const QUIZ_MESSAGES = {
  [ErrorCode.AttemptNotInProgress]: 'This attempt has already ended. Start a new one.',
  [ErrorCode.QuizAnswersInvalid]: 'Some answers do not belong to this quiz. Start a new attempt.',
  [ErrorCode.EnrollmentRequired]: 'Your enrollment is no longer active.',
};

type Answers = Record<string, number[]>;

export function QuizRunner({
  bootstrap,
  lecture,
}: {
  bootstrap: PlayerBootstrap;
  lecture: PlayerLecture;
}) {
  const queryClient = useQueryClient();
  const courseId = bootstrap.courseId;
  const preview = bootstrap.mode === 'PREVIEW';
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [result, setResult] = useState<SubmitQuizAttemptResponse | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [index, setIndex] = useState(0);

  const history = useQuery({
    queryKey: learningKeys.attempts(courseId, lecture.id),
    queryFn: ({ signal }) => fetchQuizAttempts(courseId, lecture.id, signal),
    enabled: !preview,
  });

  const start = useMutation({
    mutationFn: () => startQuizAttempt(courseId, lecture.id),
    onSuccess: (next) => {
      setAttempt(next);
      setResult(null);
      setAnswers({});
      setIndex(0);
    },
  });

  const submit = useMutation({
    mutationFn: (input: { attemptId: string; answers: Answers }) =>
      submitQuizAttempt(
        input.attemptId,
        Object.entries(input.answers).map(([questionId, optionPositions]) => ({
          questionId,
          optionPositions,
        })),
      ),
    onSuccess: (response) => {
      setResult(response);
      applyProgressAck(queryClient, courseId, lecture.id, response.progress);
      void queryClient.invalidateQueries({ queryKey: learningKeys.attempts(courseId, lecture.id) });
    },
  });

  if (result) {
    return (
      <QuizResultView
        result={result}
        questions={attempt?.questions ?? []}
        retrying={start.isPending}
        onRetry={() => start.mutate()}
        error={start.isError ? problemMessage(start.error, QUIZ_MESSAGES) : null}
      />
    );
  }

  if (attempt) {
    const question = attempt.questions[index]!;
    const last = index === attempt.questions.length - 1;
    const answered = Object.values(answers).filter((a) => a.length > 0).length;
    return (
      <section aria-label="Quiz" className="flex flex-col gap-4 rounded-lg border p-6">
        <p className="text-sm text-muted-foreground" data-testid="quiz-position">
          Question {index + 1} of {attempt.questions.length}
        </p>
        <QuestionView
          question={question}
          selected={answers[question.id] ?? []}
          onChange={(positions) => setAnswers((prev) => ({ ...prev, [question.id]: positions }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
            Previous
          </Button>
          {last ? (
            <Button
              disabled={submit.isPending}
              onClick={() => submit.mutate({ attemptId: attempt.id, answers })}
            >
              {submit.isPending ? <Spinner className="size-4" /> : null}
              Submit quiz
            </Button>
          ) : (
            <Button onClick={() => setIndex((i) => i + 1)}>Next</Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {answered} of {attempt.questions.length} answered
          </span>
        </div>
        {submit.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {problemMessage(submit.error, QUIZ_MESSAGES)}
          </p>
        ) : null}
      </section>
    );
  }

  const attempts = history.data?.items ?? [];
  const best = attempts.reduce<number | null>(
    (max, a) => (a.scorePct === null ? max : Math.max(max ?? 0, a.scorePct)),
    null,
  );
  const open = attempts.some((a) => a.status === 'IN_PROGRESS');
  return (
    <section aria-label="Quiz" className="flex flex-col items-start gap-4 rounded-lg border p-6">
      <h3 className="text-lg font-semibold">{lecture.title}</h3>
      {lecture.quiz ? (
        <p className="text-sm text-muted-foreground">
          {pluralize(lecture.quiz.questionCount, 'question')} · pass with {lecture.quiz.passPct}% or
          more
        </p>
      ) : null}
      {lecture.completed ? <Badge>Passed</Badge> : null}
      {best !== null ? (
        <p className="text-sm" data-testid="quiz-best">
          Best score: {best}% (
          {pluralize(attempts.filter((a) => a.status === 'SUBMITTED').length, 'attempt')})
        </p>
      ) : null}
      {preview ? (
        <p className="text-sm text-muted-foreground">Preview mode: quizzes cannot be taken.</p>
      ) : (
        <Button onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? <Spinner className="size-4" /> : null}
          {open ? 'Resume quiz' : attempts.length > 0 ? 'Retake quiz' : 'Start quiz'}
        </Button>
      )}
      {start.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{problemMessage(start.error, QUIZ_MESSAGES)}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function QuestionView({
  question,
  selected,
  onChange,
}: {
  question: QuizAttemptQuestion;
  selected: number[];
  onChange: (positions: number[]) => void;
}) {
  const multiple = question.kind === 'MULTIPLE_CHOICE';
  const name = `quiz-${question.id}`;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 w-full">
        <MarkdownView source={question.promptMd} idPrefix={`${name}-`} />
        <span className="mt-1 block text-xs text-muted-foreground">
          {multiple ? 'Select all that apply.' : 'Select one answer.'}
        </span>
      </legend>
      {question.options.map((option) => {
        const checked = selected.includes(option.position);
        return (
          <label
            key={option.position}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50',
              checked && 'border-primary bg-primary/5',
            )}
          >
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={name}
              checked={checked}
              onChange={() =>
                onChange(
                  multiple
                    ? checked
                      ? selected.filter((p) => p !== option.position)
                      : [...selected, option.position].sort((a, b) => a - b)
                    : [option.position],
                )
              }
              className="size-4 accent-primary"
            />
            <span>
              {optionLetter(option.position)}. {option.text}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function QuizResultView({
  result,
  questions,
  retrying,
  onRetry,
  error,
}: {
  result: SubmitQuizAttemptResponse;
  /** The attempt's questions (prompts and option texts) to label the result with. */
  questions: readonly QuizAttemptQuestion[];
  retrying: boolean;
  onRetry: () => void;
  error: string | null;
}) {
  return (
    <section aria-label="Quiz result" className="flex flex-col gap-4 rounded-lg border p-6">
      <div role="status" className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">
          {result.passed ? 'You passed!' : 'Not passed yet'}
        </h3>
        <p className="text-sm" data-testid="quiz-score">
          You scored {result.scorePct}% ({result.correctCount} of {result.questionCount} correct).
          Passing score: {result.passPct}%.
        </p>
        {!result.revealed ? (
          <p className="text-sm text-muted-foreground">
            The correct answers and explanations are shown once you pass.
          </p>
        ) : null}
      </div>
      <ol className="flex flex-col gap-3">
        {result.questions.map((question) => (
          <ResultRow
            key={question.questionId}
            question={question}
            asked={questions.find((q) => q.id === question.questionId)}
          />
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={result.passed ? 'outline' : 'default'}
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? <Spinner className="size-4" /> : null}
          {result.passed ? 'Retake quiz' : 'Try again'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function optionLetter(position: number): string {
  return String.fromCharCode(65 + position);
}

function positionsLabel(positions: readonly number[], asked?: QuizAttemptQuestion): string {
  if (positions.length === 0) return 'no answer';
  return positions
    .map((p) => {
      const text = asked?.options.find((o) => o.position === p)?.text;
      return text === undefined ? optionLetter(p) : `${optionLetter(p)}. ${text}`;
    })
    .join('; ');
}

function ResultRow({
  question,
  asked,
}: {
  question: QuizQuestionResult;
  asked: QuizAttemptQuestion | undefined;
}) {
  return (
    <li
      data-testid="quiz-result-question"
      className={cn(
        'flex flex-col gap-1 rounded-md border p-3 text-sm',
        question.yourAnswerCorrect ? 'border-emerald-600/40' : 'border-destructive/40',
      )}
    >
      <p className="font-medium">
        Question {question.position + 1}:{' '}
        {question.yourAnswerCorrect ? 'Your answer is correct' : 'Your answer is incorrect'}
      </p>
      {asked ? (
        <div className="text-muted-foreground">
          <MarkdownView source={asked.promptMd} idPrefix={`result-${question.questionId}-`} />
        </div>
      ) : null}
      <p className="text-muted-foreground">
        Your answer: {positionsLabel(question.selectedOptions, asked)}
      </p>
      {question.correctOptions !== null ? (
        <p data-testid="quiz-correct-options">
          Correct answer: {positionsLabel(question.correctOptions, asked)}
        </p>
      ) : null}
      {question.explanationMd !== null ? (
        <div data-testid="quiz-explanation" className="text-muted-foreground">
          <MarkdownView
            source={question.explanationMd}
            idPrefix={`explain-${question.questionId}-`}
          />
        </div>
      ) : null}
    </li>
  );
}
