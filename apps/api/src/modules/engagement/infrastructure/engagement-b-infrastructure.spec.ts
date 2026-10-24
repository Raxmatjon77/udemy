import { describe, expect, it, vi } from 'vitest';
import type { RealtimeEmitter } from '../../../shared/realtime';
import {
  AnnouncementNotFound,
  AnswerNotFound,
  CannotReportOwnContent,
  CannotVoteOwnContent,
  InvalidEngagementInput,
  InvalidModerationTransition,
  QuestionNotFound,
} from '../domain/engagement.errors';
import { rethrowEngagementConstraint } from './engagement-constraint-errors';
import { RealtimeQaHints } from './realtime-qa-hints';

const pgError = (constraint: string, code = '23514') =>
  Object.assign(new Error(`violates ${constraint}`), { code, constraint });

describe('Q&A / announcement constraint -> domain error map (schema doc §9)', () => {
  it.each([
    ['questions_title_ck', InvalidEngagementInput],
    ['answers_body_md_ck', InvalidEngagementInput],
    ['announcements_body_md_ck', InvalidEngagementInput],
    ['question_reports_comment_ck', InvalidEngagementInput],
    ['questions_immutable_ck', QuestionNotFound],
    ['answers_immutable_ck', AnswerNotFound],
    ['announcements_immutable_ck', AnnouncementNotFound],
    ['questions_id_accepted_answer_id_fk', AnswerNotFound],
    ['questions_accepted_answer_visible_ck', AnswerNotFound],
    ['answers_question_id_fk', QuestionNotFound],
    ['question_votes_own_content_ck', CannotVoteOwnContent],
    ['answer_votes_own_content_ck', CannotVoteOwnContent],
    ['question_votes_subject_id_fk', QuestionNotFound],
    ['answer_votes_subject_id_fk', AnswerNotFound],
    ['question_reports_own_content_ck', CannotReportOwnContent],
    ['answer_reports_subject_id_fk', AnswerNotFound],
    ['question_reports_transition_ck', InvalidModerationTransition],
    ['review_reports_transition_ck', InvalidModerationTransition],
  ])('%s', (constraint, type) => {
    const cause = pgError(constraint);
    let thrown: unknown;
    try {
      rethrowEngagementConstraint(cause);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(type);
    expect((thrown as Error).cause).toBe(cause);
  });

  it('the counter guards stay 500 (the app never writes counters)', () => {
    const counters = pgError('questions_counters_ck');
    expect(() => rethrowEngagementConstraint(counters)).toThrow(counters);
  });
});

describe('RealtimeQaHints', () => {
  const hint = { courseId: 'c1', questionId: 'q1', lectureId: null };

  it('emits qa.changed to the course room', async () => {
    const emit = vi.fn(async () => undefined);
    await new RealtimeQaHints({ emit } as unknown as RealtimeEmitter).changed(hint);
    expect(emit).toHaveBeenCalledWith('c:c1', 'qa.changed', hint);
  });

  it('never rejects: the write already committed (best effort)', async () => {
    const emit = vi.fn(async () => {
      throw new Error('redis down');
    });
    await expect(
      new RealtimeQaHints({ emit } as unknown as RealtimeEmitter).changed(hint),
    ).resolves.toBeUndefined();
  });
});
