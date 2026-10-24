import { describe, expect, it } from 'vitest';
import { announcementQuota } from './announcement';
import {
  acceptsAnswers,
  type AnswerRecord,
  canResolve,
  canSeeAnswer,
  canSeeQuestion,
  type QuestionRecord,
} from './qa';

const DAY_MS = 86_400_000;
const at = new Date('2026-10-01T00:00:00.000Z');

const question = (over: Partial<QuestionRecord> = {}): QuestionRecord => ({
  id: 'q1',
  courseId: 'c1',
  lectureId: null,
  authorId: 'author',
  title: 'Title here',
  bodyMd: 'Body',
  acceptedAnswerId: null,
  moderationStatus: 'VISIBLE',
  upvoteCount: 0,
  answerCount: 0,
  lastActivityAt: at,
  createdAt: at,
  editedAt: null,
  deletedAt: null,
  ...over,
});

const answer = (over: Partial<AnswerRecord> = {}): AnswerRecord => ({
  id: 'a1',
  questionId: 'q1',
  authorId: 'author',
  bodyMd: 'Body',
  upvoteCount: 0,
  moderationStatus: 'VISIBLE',
  createdAt: at,
  editedAt: null,
  deletedAt: null,
  ...over,
});

describe('Q&A visibility (design §9 "Moderation")', () => {
  it('hidden content is visible to its author only; deleted questions only as placeholders with answers', () => {
    expect(canSeeQuestion(question(), 'x')).toBe(true);
    expect(canSeeQuestion(question({ moderationStatus: 'HIDDEN' }), 'x')).toBe(false);
    expect(canSeeQuestion(question({ moderationStatus: 'HIDDEN' }), 'author')).toBe(true);
    expect(canSeeQuestion(question({ deletedAt: at }), 'x')).toBe(false);
    expect(canSeeQuestion(question({ deletedAt: at, answerCount: 2 }), 'x')).toBe(true);
    expect(acceptsAnswers(question({ moderationStatus: 'HIDDEN' }))).toBe(false);
    expect(acceptsAnswers(question({ deletedAt: at, answerCount: 1 }))).toBe(false);

    expect(canSeeAnswer(answer(), 'x')).toBe(true);
    expect(canSeeAnswer(answer({ moderationStatus: 'HIDDEN' }), 'x')).toBe(false);
    expect(canSeeAnswer(answer({ moderationStatus: 'HIDDEN' }), 'author')).toBe(true);
    expect(canSeeAnswer(answer({ deletedAt: at }), 'author')).toBe(false);
  });

  it('the question author or the course owner may accept', () => {
    expect(canResolve(question(), 'author', 'owner')).toBe(true);
    expect(canResolve(question(), 'owner', 'owner')).toBe(true);
    expect(canResolve(question(), 'someone', 'owner')).toBe(false);
  });
});

describe('announcementQuota (D18: 4 per course per rolling 30 days)', () => {
  it('free below the limit; at the limit the oldest blocking post + 30 days', () => {
    const d = (days: number) => new Date(at.getTime() + days * DAY_MS);
    expect(announcementQuota([])).toEqual({
      limit: 4,
      used: 0,
      windowDays: 30,
      nextAvailableAt: null,
    });
    expect(announcementQuota([d(0), d(1), d(2)]).nextAvailableAt).toBeNull();
    expect(announcementQuota([d(3), d(0), d(2), d(1)])).toMatchObject({
      used: 4,
      nextAvailableAt: d(30),
    });
    // over the limit (e.g. counted under a lower old limit): the post that keeps it full
    expect(announcementQuota([d(0), d(1), d(2), d(3), d(4)]).nextAvailableAt).toEqual(d(31));
  });
});
