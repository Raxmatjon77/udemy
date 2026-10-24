import { Injectable } from '@nestjs/common';
import type { Answer, PersonRef, Question } from '@udemy/contracts';
import type { AnswerRecord, QuestionRecord } from '../domain/qa';
import { PeopleDirectory, personOf } from './people';
import { QaRepository } from './ports/qa.repository';

type People = ReadonlyMap<string, PersonRef>;

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** Whose Q&A view this is: the caller and the course owner (instructor badge, D12). */
export interface QaViewContext {
  readonly viewerId: string;
  readonly ownerId: string;
}

export function toQuestion(
  q: QuestionRecord,
  ctx: QaViewContext,
  people: People,
  voted: ReadonlySet<string>,
): Question {
  const deleted = q.deletedAt !== null;
  return {
    id: q.id,
    courseId: q.courseId,
    lectureId: q.lectureId,
    // a deleted question with answers stays as a "[deleted]" placeholder: no text, no author
    title: deleted ? null : q.title,
    bodyMd: deleted ? null : q.bodyMd,
    author: deleted ? null : personOf(people, q.authorId),
    byInstructor: q.authorId === ctx.ownerId,
    mine: q.authorId === ctx.viewerId,
    upvoteCount: q.upvoteCount,
    answerCount: q.answerCount,
    acceptedAnswerId: q.acceptedAnswerId,
    resolved: q.acceptedAnswerId !== null,
    voted: voted.has(q.id),
    hidden: q.moderationStatus === 'HIDDEN',
    deleted,
    createdAt: iso(q.createdAt),
    editedAt: isoOrNull(q.editedAt),
    lastActivityAt: iso(q.lastActivityAt),
  };
}

export function toAnswer(
  a: AnswerRecord,
  question: Pick<QuestionRecord, 'acceptedAnswerId'>,
  ctx: QaViewContext,
  people: People,
  voted: ReadonlySet<string>,
): Answer {
  const deleted = a.deletedAt !== null;
  return {
    id: a.id,
    questionId: a.questionId,
    bodyMd: deleted ? null : a.bodyMd,
    author: personOf(people, a.authorId),
    byInstructor: a.authorId === ctx.ownerId,
    mine: a.authorId === ctx.viewerId,
    upvoteCount: a.upvoteCount,
    voted: voted.has(a.id),
    accepted: question.acceptedAnswerId === a.id,
    hidden: a.moderationStatus === 'HIDDEN',
    deleted,
    createdAt: iso(a.createdAt),
    editedAt: isoOrNull(a.editedAt),
  };
}

/**
 * Renders Q&A records for one viewer: public author profiles (banned = null, "Former student"),
 * the instructor badge (author = course owner, computed at read time) and the viewer's votes
 * (one query per page). Only records the viewer may see are passed in.
 */
@Injectable()
export class QaPresenter {
  constructor(
    private readonly qa: QaRepository,
    private readonly people: PeopleDirectory,
  ) {}

  /** Questions that may belong to different courses: `ownerOf(courseId)` gives each owner. */
  async questions(
    records: readonly QuestionRecord[],
    viewerId: string,
    ownerOf: (courseId: string) => string,
  ): Promise<Question[]> {
    const [people, voted] = await Promise.all([
      this.people.lookup(records.map((q) => q.authorId)),
      this.qa.votedAmong(
        'QUESTION',
        records.map((q) => q.id),
        viewerId,
      ),
    ]);
    return records.map((q) =>
      toQuestion(q, { viewerId, ownerId: ownerOf(q.courseId) }, people, voted),
    );
  }

  async question(record: QuestionRecord, ctx: QaViewContext): Promise<Question> {
    const [question] = await this.questions([record], ctx.viewerId, () => ctx.ownerId);
    if (question === undefined) throw new Error('presenting one question yielded none');
    return question;
  }

  async answers(
    records: readonly AnswerRecord[],
    question: Pick<QuestionRecord, 'acceptedAnswerId'>,
    ctx: QaViewContext,
  ): Promise<Answer[]> {
    const [people, voted] = await Promise.all([
      this.people.lookup(records.map((a) => a.authorId)),
      this.qa.votedAmong(
        'ANSWER',
        records.map((a) => a.id),
        ctx.viewerId,
      ),
    ]);
    return records.map((a) => toAnswer(a, question, ctx, people, voted));
  }

  async answer(
    record: AnswerRecord,
    question: Pick<QuestionRecord, 'acceptedAnswerId'>,
    ctx: QaViewContext,
  ): Promise<Answer> {
    const [answer] = await this.answers([record], question, ctx);
    if (answer === undefined) throw new Error('presenting one answer yielded none');
    return answer;
  }
}
