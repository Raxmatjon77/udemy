'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ErrorCode,
  QUIZ_QUESTION_KIND_LABELS,
  RevisionQuizSchema,
  type LectureQuizSummary,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';
import { Badge } from '@udemy/ui/components/badge';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { api } from '@/lib/api';
import { problemMessage, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

/** `GET /admin/course-revisions/:rid/lectures/:lid/quiz` (the immutable snapshot, with keys). */
export function revisionQuizPath(revisionId: string, lectureId: string): string {
  return `/admin/course-revisions/${encodeURIComponent(revisionId)}/lectures/${encodeURIComponent(lectureId)}/quiz`;
}

const QUIZ_MESSAGES: MessageOverrides = {
  [ErrorCode.LectureNotFound]: 'This quiz is not part of this revision.',
  [ErrorCode.LectureTypeMismatch]: 'This lecture has no quiz in this revision.',
  [ErrorCode.NotFound]: 'This revision no longer exists.',
};

/**
 * A QUIZ lecture of a revision under review (Phase 5 design D6, §10 web-admin): the pass mark and
 * every question with its options, the correct ones marked (by text, not color only), and the
 * explanations. Only admins and the owner ever see answer keys; they are moderated with the
 * revision. Loaded when the lecture is opened.
 */
export function RevisionQuizPreview({
  revisionId,
  lectureId,
  summary,
}: {
  revisionId: string;
  lectureId: string;
  summary: LectureQuizSummary | null | undefined;
}) {
  const quiz = useQuery({
    queryKey: queryKeys.revisionQuiz(revisionId, lectureId),
    queryFn: () => api(revisionQuizPath(revisionId, lectureId), { schema: RevisionQuizSchema }),
  });

  const passPct = quiz.data?.passPct ?? summary?.passPct;
  const count = quiz.data?.questions.length ?? summary?.questionCount;

  return (
    <div className="grid gap-4">
      {passPct !== undefined && count !== undefined ? (
        <p className="text-sm text-muted-foreground">
          {count} question{count === 1 ? '' : 's'} · pass mark {passPct}%
        </p>
      ) : null}
      {quiz.isPending ? (
        <div aria-busy="true" aria-label="Loading the quiz" className="grid gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : quiz.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(quiz.error, QUIZ_MESSAGES)}
        </p>
      ) : (
        <ol className="grid gap-4" aria-label="Quiz questions">
          {quiz.data.questions.map((question, index) => (
            <li key={question.id} className="grid gap-2 rounded-md border bg-background p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">Question {index + 1}</span>
                <Badge variant="outline">{QUIZ_QUESTION_KIND_LABELS[question.kind]}</Badge>
              </div>
              <MarkdownView
                source={question.promptMd}
                idPrefix={`quiz-${question.id}-prompt-`}
                className="text-sm"
              />
              <ul className="grid gap-1" aria-label={`Options of question ${index + 1}`}>
                {question.options.map((option) => (
                  <li
                    key={option.position}
                    className={
                      option.isCorrect
                        ? 'flex items-center gap-2 rounded border border-primary/40 bg-primary/5 px-2 py-1 text-sm'
                        : 'flex items-center gap-2 rounded border px-2 py-1 text-sm'
                    }
                  >
                    <span>{option.text}</span>
                    {option.isCorrect ? <Badge variant="secondary">Correct</Badge> : null}
                  </li>
                ))}
              </ul>
              {question.explanationMd ? (
                <div className="grid gap-1 border-t pt-2">
                  <span className="text-xs font-medium text-muted-foreground">Explanation</span>
                  <MarkdownView
                    source={question.explanationMd}
                    idPrefix={`quiz-${question.id}-explanation-`}
                    className="text-sm"
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
