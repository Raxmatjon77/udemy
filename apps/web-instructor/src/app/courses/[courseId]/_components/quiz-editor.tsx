'use client';

import { useId, useState, type FormEvent } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  isQuizQuestionComplete,
  PutQuizQuestionOptionsRequestSchema,
  QUIZ_LIMITS,
  QUIZ_QUESTION_KIND_LABELS,
  QUIZ_QUESTION_KINDS,
  QuizExplanationSchema,
  QuizPassPctSchema,
  QuizPromptSchema,
  type QuizAuthoring,
  type QuizQuestionAuthoring,
  type QuizQuestionKind,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Input } from '@udemy/ui/components/input';
import { Label } from '@udemy/ui/components/label';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Textarea } from '@udemy/ui/components/textarea';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { MarkdownEditor } from '@/components/markdown-editor';
import { QueryError } from '@/components/query-error';
import { catalogKeys } from '@/lib/catalog-queries';
import { markdownIssues, type MarkdownIssueView } from '@/lib/markdown-issues';
import { hasCode, problemMessage } from '@/lib/problem';
import { quizApi, quizKeys } from '@/lib/quiz-api';
import { friendlyZodError } from '@/lib/zod-messages';

/**
 * The quiz editor of a QUIZ lecture (Phase 5 design D6, §10 "Builder"): the pass mark, the
 * questions in order (drag and drop or move buttons), and per question its kind (single or
 * multiple choice), prompt and explanation (markdown) and 2–6 options with the correct ones
 * marked. Drafts may be incomplete; each incomplete question says why inline (the readiness
 * rule `QUIZ_QUESTION_INVALID`), and an empty quiz says so (`QUIZ_EMPTY`). Students never see
 * the correct flags or explanations before they pass (Q5); admins review them with the revision.
 */
export function QuizEditor({
  courseId,
  lectureId,
  readOnly,
}: {
  courseId: string;
  lectureId: string;
  readOnly: boolean;
}) {
  const quiz = useQuery({
    queryKey: quizKeys.quiz(courseId, lectureId),
    queryFn: () => quizApi.get(courseId, lectureId),
    staleTime: 0,
  });
  if (quiz.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading the quiz" className="grid gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (quiz.isError) {
    return <QueryError error={quiz.error} onRetry={() => void quiz.refetch()} />;
  }
  return <QuizForm quiz={quiz.data} readOnly={readOnly || quiz.data.locked} />;
}

/** Reloads the quiz, and the curriculum + course (quiz summary, readiness, version). */
function useQuizRefresh(courseId: string, lectureId: string) {
  const queryClient = useQueryClient();
  return {
    setQuiz: (data: QuizAuthoring) =>
      queryClient.setQueryData(quizKeys.quiz(courseId, lectureId), data),
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: quizKeys.quiz(courseId, lectureId) });
      void queryClient.invalidateQueries({
        queryKey: catalogKeys.curriculum(courseId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.course(courseId), exact: true });
    },
  };
}

/** Why a question blocks submission (`isQuizQuestionComplete`), in words; null when complete. */
export function questionIssue(
  kind: QuizQuestionKind,
  options: readonly { isCorrect: boolean }[],
): string | null {
  if (isQuizQuestionComplete(kind, options)) return null;
  if (options.length < QUIZ_LIMITS.minOptions || options.length > QUIZ_LIMITS.maxOptions) {
    return `Add ${QUIZ_LIMITS.minOptions} to ${QUIZ_LIMITS.maxOptions} options.`;
  }
  return kind === 'SINGLE_CHOICE'
    ? 'Mark exactly one option as correct.'
    : 'Mark at least one option as correct.';
}

function QuizForm({ quiz, readOnly }: { quiz: QuizAuthoring; readOnly: boolean }) {
  const { courseId, lectureId } = quiz;
  const { setQuiz, refresh } = useQuizRefresh(courseId, lectureId);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  /** Optimistic order while a reorder is in flight. */
  const [order, setOrder] = useState<string[] | null>(null);

  function onWriteError(error: unknown) {
    setNotice(problemMessage(error));
    if (
      hasCode(error, ErrorCode.CourseInReview) ||
      hasCode(error, ErrorCode.QuizQuestionNotFound) ||
      hasCode(error, ErrorCode.OrderMismatch)
    ) {
      refresh();
    }
  }

  const reorder = useMutation({
    mutationFn: (ids: string[]) => quizApi.reorder(courseId, lectureId, ids),
    onSuccess: (data) => {
      setQuiz(data);
      refresh();
    },
    onError: onWriteError,
    onSettled: () => setOrder(null),
  });

  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const ids = order ?? quiz.questions.map((q) => q.id);
  const questions = ids.flatMap((id) => {
    const q = byId.get(id);
    return q ? [q] : [];
  });
  const incomplete = quiz.questions.filter((q) => !q.complete).length;

  function move(id: string, to: number) {
    const from = ids.indexOf(id);
    if (from === -1 || to < 0 || to >= ids.length || to === from) return;
    const next = arrayMove(ids, from, to);
    setNotice(null);
    setOrder(next);
    setStatus(`Moved question ${from + 1} to position ${to + 1}.`);
    reorder.mutate(next);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd({ active, over }: DragEndEvent) {
    if (over && active.id !== over.id) move(String(active.id), ids.indexOf(String(over.id)));
  }

  return (
    <section aria-labelledby={`quiz-heading-${lectureId}`} className="grid gap-6">
      <div className="grid gap-1">
        <h3 id={`quiz-heading-${lectureId}`} className="text-lg font-semibold">
          Quiz
        </h3>
        <p className="text-sm text-muted-foreground">
          {quiz.questions.length} of at most {QUIZ_LIMITS.maxQuestions} questions. Students see
          whether their own answers were right; the correct options and explanations only after they
          pass.
        </p>
      </div>

      <div role="alert" aria-live="assertive">
        {notice ? <p className="text-sm text-destructive">{notice}</p> : null}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {reorder.isPending ? 'Saving the new order…' : status}
      </p>

      <PassMarkForm quiz={quiz} readOnly={readOnly} onError={onWriteError} />

      {quiz.questions.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          This quiz has no questions yet. Add at least one before you submit the course.
        </p>
      ) : incomplete > 0 ? (
        <p className="text-sm text-destructive">
          {incomplete} {incomplete === 1 ? 'question is' : 'questions are'} not complete yet. The
          course cannot be submitted until every question has 2–6 options and its correct answer(s)
          marked.
        </p>
      ) : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className="grid gap-4" aria-label="Questions" aria-busy={reorder.isPending}>
            {questions.map((question, index) => (
              <QuestionCard
                key={question.id}
                courseId={courseId}
                lectureId={lectureId}
                question={question}
                number={index + 1}
                readOnly={readOnly}
                canMoveUp={!reorder.isPending && index > 0}
                canMoveDown={!reorder.isPending && index < questions.length - 1}
                onMoveUp={() => move(question.id, index - 1)}
                onMoveDown={() => move(question.id, index + 1)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      {readOnly ? null : adding ? (
        <div className="grid gap-3 rounded-lg border p-4">
          <h4 className="font-medium">New question</h4>
          <QuestionForm
            courseId={courseId}
            lectureId={lectureId}
            question={null}
            onDone={() => setAdding(false)}
          />
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={quiz.questions.length >= QUIZ_LIMITS.maxQuestions}
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            Add question
          </Button>
        </div>
      )}
    </section>
  );
}

function PassMarkForm({
  quiz,
  readOnly,
  onError,
}: {
  quiz: QuizAuthoring;
  readOnly: boolean;
  onError: (error: unknown) => void;
}) {
  const { courseId, lectureId } = quiz;
  const { setQuiz, refresh } = useQuizRefresh(courseId, lectureId);
  const [value, setValue] = useState(String(quiz.passPct));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const id = `quiz-pass-${lectureId}`;
  const save = useMutation({
    mutationFn: (passPct: number) => quizApi.setPassPct(courseId, lectureId, passPct),
    onSuccess: (data) => {
      setQuiz(data);
      setSaved('Pass mark saved.');
      refresh();
    },
    onError,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = QuizPassPctSchema.safeParse(Number(value.trim() === '' ? Number.NaN : value));
    if (!parsed.success) {
      setError('Enter a whole number from 1 to 100.');
      return;
    }
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-2">
      <Label htmlFor={id}>Pass mark (%)</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(null);
          }}
          disabled={readOnly}
          className="w-28"
          aria-invalid={Boolean(error)}
          aria-describedby={`${id}-description${error ? ` ${id}-error` : ''}`}
        />
        {readOnly ? null : (
          <Button
            type="submit"
            variant="outline"
            disabled={save.isPending || value === String(quiz.passPct)}
          >
            Save pass mark
          </Button>
        )}
        <span role="status" className="text-sm text-muted-foreground">
          {saved}
        </span>
      </div>
      <p id={`${id}-description`} className="text-xs text-muted-foreground">
        The share of questions a student must answer correctly to pass (default{' '}
        {QUIZ_LIMITS.defaultPassPct}%).
      </p>
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function QuestionCard({
  courseId,
  lectureId,
  question,
  number,
  readOnly,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  courseId: string;
  lectureId: string;
  question: QuizQuestionAuthoring;
  number: number;
  readOnly: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { refresh } = useQuizRefresh(courseId, lectureId);
  const [editing, setEditing] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: question.id,
    disabled: readOnly || editing,
  });
  const headingId = useId();
  const issue = question.complete ? null : questionIssue(question.kind, question.options);
  const name = `question ${number}`;

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      aria-labelledby={headingId}
      className="grid gap-3 rounded-lg border bg-background p-4"
      data-testid={`quiz-question-${question.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {readOnly || editing ? null : (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag ${name}`}
            className="cursor-grab rounded px-1 text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            ⠿
          </button>
        )}
        <h4 id={headingId} className="font-medium">
          Question {number}
        </h4>
        <Badge variant="outline">{QUIZ_QUESTION_KIND_LABELS[question.kind]}</Badge>
        {issue ? <Badge variant="destructive">Incomplete</Badge> : null}
        {readOnly || editing ? null : (
          <div className="ml-auto flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canMoveUp}
              onClick={onMoveUp}
              aria-label={`Move ${name} up`}
            >
              ↑
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canMoveDown}
              onClick={onMoveDown}
              aria-label={`Move ${name} down`}
            >
              ↓
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${name}`}
            >
              Edit
            </Button>
            <ConfirmDialog
              trigger={
                <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${name}`}>
                  Delete
                </Button>
              }
              title="Delete this question?"
              description={`Question ${number} and its options are removed from the quiz.`}
              confirmLabel="Delete question"
              pendingLabel="Deleting…"
              onConfirm={async () => {
                try {
                  await quizApi.deleteQuestion(courseId, lectureId, question.id);
                } catch (error) {
                  if (hasCode(error, ErrorCode.QuizQuestionNotFound)) refresh();
                  throw error;
                }
                refresh();
              }}
            />
          </div>
        )}
      </div>

      {issue ? <p className="text-sm text-destructive">{issue}</p> : null}

      {editing ? (
        <QuestionForm
          courseId={courseId}
          lectureId={lectureId}
          question={question}
          onDone={() => setEditing(false)}
        />
      ) : (
        <div className="grid gap-3">
          <MarkdownView
            source={question.promptMd}
            idPrefix={`quiz-${question.id}-prompt-`}
            className="text-sm"
          />
          {question.options.length === 0 ? (
            <p className="text-sm text-muted-foreground">No options yet.</p>
          ) : (
            <ul className="grid gap-1" aria-label={`Options of ${name}`}>
              {question.options.map((option) => (
                <li key={option.position} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className={option.isCorrect ? 'text-primary' : 'text-muted-foreground'}
                  >
                    {option.isCorrect ? '✓' : '○'}
                  </span>
                  <span>{option.text}</span>
                  {option.isCorrect ? <Badge variant="secondary">Correct</Badge> : null}
                </li>
              ))}
            </ul>
          )}
          {question.explanationMd ? (
            <div className="grid gap-1 rounded-md bg-muted/50 p-3">
              <p className="text-xs font-medium text-muted-foreground">Explanation</p>
              <MarkdownView
                source={question.explanationMd}
                idPrefix={`quiz-${question.id}-explanation-`}
                className="text-sm"
              />
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}

interface OptionDraft {
  key: number;
  text: string;
  isCorrect: boolean;
}

let nextOptionKey = 1;
function draftOf(options: readonly { text: string; isCorrect: boolean }[]): OptionDraft[] {
  return options.map((o) => ({ key: nextOptionKey++, text: o.text, isCorrect: o.isCorrect }));
}
function emptyOption(): OptionDraft {
  return { key: nextOptionKey++, text: '', isCorrect: false };
}

function sameOptions(
  a: readonly OptionDraft[],
  b: readonly { text: string; isCorrect: boolean }[],
) {
  return (
    a.length === b.length &&
    a.every((o, i) => o.text.trim() === b[i]!.text && o.isCorrect === b[i]!.isCorrect)
  );
}

/**
 * Create (`question` null: POST, then PUT the options when there are any) or edit (PATCH the
 * changed fields, PUT the options when they changed) one question.
 */
function QuestionForm({
  courseId,
  lectureId,
  question,
  onDone,
}: {
  courseId: string;
  lectureId: string;
  question: QuizQuestionAuthoring | null;
  onDone: () => void;
}) {
  const { refresh } = useQuizRefresh(courseId, lectureId);
  const base = useId();
  const [kind, setKind] = useState<QuizQuestionKind>(question?.kind ?? 'SINGLE_CHOICE');
  const [prompt, setPrompt] = useState(question?.promptMd ?? '');
  const [explanation, setExplanation] = useState(question?.explanationMd ?? '');
  const [options, setOptions] = useState<OptionDraft[]>(() =>
    question ? draftOf(question.options) : [emptyOption(), emptyOption()],
  );
  const [errors, setErrors] = useState<{
    prompt?: string;
    explanation?: string;
    options?: string;
    form?: string;
  }>({});
  const [promptIssues, setPromptIssues] = useState<MarkdownIssueView[] | null>(null);

  const save = useMutation({
    mutationFn: async (input: {
      promptMd: string;
      explanationMd: string | null;
      options: { text: string; isCorrect: boolean }[] | null;
    }) => {
      let id = question?.id;
      if (!question) {
        const created = await quizApi.addQuestion(courseId, lectureId, {
          kind,
          promptMd: input.promptMd,
          ...(input.explanationMd ? { explanationMd: input.explanationMd } : {}),
        });
        id = created.id;
      } else {
        const patch = {
          ...(kind !== question.kind ? { kind } : {}),
          ...(input.promptMd !== question.promptMd ? { promptMd: input.promptMd } : {}),
          ...(input.explanationMd !== question.explanationMd
            ? { explanationMd: input.explanationMd }
            : {}),
        };
        if (Object.keys(patch).length > 0) {
          await quizApi.updateQuestion(courseId, lectureId, question.id, patch);
        }
      }
      if (input.options && id) {
        await quizApi.putOptions(courseId, lectureId, id, { options: input.options });
      }
    },
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: (error) => {
      // A question created before its options failed is kept (a draft): reload to show it.
      if (
        !question ||
        hasCode(error, ErrorCode.CourseInReview) ||
        hasCode(error, ErrorCode.QuizQuestionNotFound)
      ) {
        refresh();
      }
      const issues = markdownIssues(error, 'promptMd');
      setPromptIssues(issues);
      setErrors({
        form: issues
          ? 'The question contains formatting that is not allowed. See the marked lines.'
          : problemMessage(error),
      });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof errors = {};
    const promptParsed = QuizPromptSchema.safeParse(prompt, { error: friendlyZodError });
    if (!promptParsed.success) next.prompt = promptParsed.error.issues[0]?.message ?? 'Invalid';
    const explanationText = explanation.trim();
    let explanationMd: string | null = null;
    if (explanationText !== '') {
      const parsed = QuizExplanationSchema.safeParse(explanation, { error: friendlyZodError });
      if (parsed.success) explanationMd = parsed.data;
      else next.explanation = parsed.error.issues[0]?.message ?? 'Invalid';
    }
    const filled = options.filter((o) => o.text.trim() !== '');
    let optionsBody: { text: string; isCorrect: boolean }[] | null = null;
    const unchanged = question !== null && sameOptions(filled, question.options);
    if (!unchanged && !(question === null && filled.length === 0)) {
      const parsed = PutQuizQuestionOptionsRequestSchema.safeParse(
        { options: filled.map((o) => ({ text: o.text, isCorrect: o.isCorrect })) },
        { error: friendlyZodError },
      );
      if (parsed.success) optionsBody = parsed.data.options;
      else if (filled.length < QUIZ_LIMITS.minOptions) {
        next.options = `Add at least ${QUIZ_LIMITS.minOptions} options (empty ones are ignored).`;
      } else {
        next.options = parsed.error.issues[0]?.message ?? 'Check the options.';
      }
    }
    setErrors(next);
    setPromptIssues(null);
    if (Object.keys(next).length > 0) return;
    save.mutate({
      promptMd: promptParsed.success ? promptParsed.data : prompt,
      explanationMd,
      options: optionsBody,
    });
  }

  function setOption(key: number, change: Partial<OptionDraft>) {
    setErrors(({ options: _stale, ...rest }) => rest);
    setOptions((current) =>
      current.map((o) => {
        if (o.key === key) return { ...o, ...change };
        // Single choice: marking one correct clears the others.
        if (change.isCorrect && kind === 'SINGLE_CHOICE') return { ...o, isCorrect: false };
        return o;
      }),
    );
  }

  const draftIssue = questionIssue(
    kind,
    options.filter((o) => o.text.trim() !== ''),
  );
  const optionGroup = `${base}-options`;

  return (
    <form onSubmit={submit} noValidate className="grid gap-4" aria-label="Question">
      {errors.form ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.form}
        </p>
      ) : null}
      <div className="grid gap-1">
        <Label htmlFor={`${base}-kind`}>Question type</Label>
        <NativeSelect
          id={`${base}-kind`}
          value={kind}
          onChange={(event) => {
            const next = event.target.value as QuizQuestionKind;
            setKind(next);
            if (next === 'SINGLE_CHOICE') {
              // Keep only the first correct option.
              let seen = false;
              setOptions((current) =>
                current.map((o) => {
                  const keep = o.isCorrect && !seen;
                  if (o.isCorrect) seen = true;
                  return { ...o, isCorrect: keep };
                }),
              );
            }
          }}
          className="w-56"
        >
          {QUIZ_QUESTION_KINDS.map((value) => (
            <option key={value} value={value}>
              {QUIZ_QUESTION_KIND_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <MarkdownEditor
        id={`${base}-prompt`}
        label="Question"
        value={prompt}
        onChange={setPrompt}
        error={errors.prompt}
        issues={promptIssues}
        maxLength={2000}
        rows={4}
        description="Markdown: code, lists and links. No HTML or images."
      />
      <fieldset className="grid gap-2" aria-describedby={`${optionGroup}-hint`}>
        <legend className="text-sm font-medium">Options</legend>
        <p id={`${optionGroup}-hint`} className="text-xs text-muted-foreground">
          {QUIZ_LIMITS.minOptions} to {QUIZ_LIMITS.maxOptions} options.{' '}
          {kind === 'SINGLE_CHOICE' ? 'Mark the one correct option.' : 'Mark every correct option.'}
        </p>
        {options.map((option, index) => {
          const n = index + 1;
          return (
            <div key={option.key} className="flex items-center gap-2">
              <input
                type={kind === 'SINGLE_CHOICE' ? 'radio' : 'checkbox'}
                name={`${optionGroup}-correct`}
                className="size-4 accent-primary"
                checked={option.isCorrect}
                onChange={(event) => setOption(option.key, { isCorrect: event.target.checked })}
                aria-label={`Option ${n} is correct`}
              />
              <Input
                value={option.text}
                onChange={(event) => setOption(option.key, { text: event.target.value })}
                maxLength={300}
                aria-label={`Option ${n}`}
                className="h-8"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setOptions((current) => current.filter((o) => o.key !== option.key))}
                aria-label={`Remove option ${n}`}
              >
                ✕
              </Button>
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={options.length >= QUIZ_LIMITS.maxOptions}
            onClick={() => setOptions((current) => [...current, emptyOption()])}
          >
            Add option
          </Button>
        </div>
        {errors.options ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.options}
          </p>
        ) : draftIssue ? (
          <p className="text-xs text-muted-foreground">
            Not complete yet: {draftIssue} You can save a draft and finish it later.
          </p>
        ) : null}
      </fieldset>
      <div className="grid gap-1">
        <Label htmlFor={`${base}-explanation`}>Explanation (optional)</Label>
        <Textarea
          id={`${base}-explanation`}
          value={explanation}
          onChange={(event) => setExplanation(event.target.value)}
          maxLength={2000}
          rows={3}
          aria-invalid={Boolean(errors.explanation)}
          aria-describedby={`${base}-explanation-description${
            errors.explanation ? ` ${base}-explanation-error` : ''
          }`}
        />
        <p id={`${base}-explanation-description`} className="text-xs text-muted-foreground">
          Markdown. Shown to students after they pass the quiz.
        </p>
        {errors.explanation ? (
          <p id={`${base}-explanation-error`} className="text-sm text-destructive">
            {errors.explanation}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : question ? 'Save question' : 'Add question'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
