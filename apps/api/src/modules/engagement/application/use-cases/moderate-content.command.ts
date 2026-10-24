import { Injectable } from '@nestjs/common';
import type { ModerationSubject, ReportSubjectType } from '@udemy/contracts';
import {
  AnswerNotFound,
  InvalidModerationTransition,
  QuestionNotFound,
  ReplyNotFound,
  ReviewNotFound,
} from '../../domain/engagement.errors';
import {
  ADMIN_MODERATION_ACTIONS,
  type AdminModerationRouteAction,
  type ModerationSubjectRecord,
  subjectKey,
} from '../../domain/moderation';
import { ModerationEvents } from '../moderation-events';
import { ModerationReader } from '../moderation-reader';
import { toModerationSubject } from '../moderation-views';
import { ModerationRepository } from '../ports/moderation.repository';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';

export interface ModerateContentInput {
  /** The admin (`content:moderate:any`). */
  readonly actorId: string;
  readonly subjectType: ReportSubjectType;
  /** The `:subjectId` route param (REVIEW_REPLY: the review id). */
  readonly routeId: string;
  readonly action: AdminModerationRouteAction;
  /** 10-2000 characters; stored in the append-only audit log. */
  readonly reason: string;
}

const NOT_FOUND: Readonly<Record<ReportSubjectType, () => Error>> = {
  REVIEW: () => new ReviewNotFound(),
  REVIEW_REPLY: () => new ReplyNotFound(),
  QUESTION: () => new QuestionNotFound(),
  ANSWER: () => new AnswerNotFound(),
};

/**
 * `AdminHide` / `AdminRestore` / `AdminDismissReports` (design §5, D13): a conditional state
 * change under the subject row lock (`@udemy/db` `moderateSubject`) with the reason in the
 * append-only `moderation_actions` audit log, in one transaction with the event:
 *
 * - hide: VISIBLE -> HIDDEN, open reports ACTIONED, `…Hidden` (actor = admin; hiding the
 *   accepted answer also clears it and emits `QuestionReopened`). On already hidden content
 *   with open reports it confirms the hide (audit row, reports ACTIONED, no event).
 * - restore: HIDDEN -> VISIBLE, open reports DISMISSED, `…Restored`.
 * - dismiss-reports: open reports DISMISSED (no state change, no event); also allowed on
 *   deleted content, so the queue can be cleared.
 *
 * Everything else is 409 `invalid_state_transition` (hide/restore of deleted content too).
 * Q&A changes push a `qa.changed` hint after the commit.
 *
 * Errors: 404 (the subject's `*_not_found`), 409 `invalid_state_transition`.
 */
@Injectable()
export class ModerateContentCommand {
  constructor(
    private readonly moderation: ModerationRepository,
    private readonly qa: QaRepository,
    private readonly events: ModerationEvents,
    private readonly tx: TransactionRunner,
    private readonly reader: ModerationReader,
    private readonly hints: QaHints,
  ) {}

  async execute(input: ModerateContentInput): Promise<ModerationSubject> {
    const subject = await this.moderation.resolveRoute(input.subjectType, input.routeId);
    if (subject === null) throw NOT_FOUND[input.subjectType]();
    const action = ADMIN_MODERATION_ACTIONS[input.action];
    const ref = { type: subject.type, id: subject.id };

    const statusChanged = await this.tx.run(async (trx) => {
      // answer -> question lock order; learn whether hiding clears the accepted answer
      const acceptance =
        subject.type === 'ANSWER' && action === 'HIDE'
          ? await this.qa.lockAnswerAcceptance(trx, subject.id)
          : null;
      const outcome = await this.moderation.moderate(trx, {
        ref,
        action,
        actorId: input.actorId,
        reason: input.reason,
      });
      if (outcome.outcome === 'NOT_FOUND') throw NOT_FOUND[input.subjectType]();
      if (outcome.outcome !== 'APPLIED') throw new InvalidModerationTransition();
      if (!outcome.statusChanged) return false;
      const at = await this.moderation.transactionNow(trx);
      const eventRef = { ...subject, subjectId: subject.id };
      if (action === 'HIDE') {
        await this.events.hidden(trx, eventRef, input.actorId, at, {
          wasAcceptedAnswer: acceptance?.wasAccepted ?? false,
        });
      } else {
        await this.events.restored(trx, eventRef, input.actorId, at);
      }
      return true;
    });
    if (statusChanged) await this.hint(subject);
    return this.view(subject);
  }

  private async hint(subject: ModerationSubjectRecord): Promise<void> {
    if (subject.questionId === null) return;
    await this.hints.changed({
      courseId: subject.courseId,
      questionId: subject.questionId,
      lectureId: subject.lectureId,
    });
  }

  /** The subject after the action (state, open reports, audit log). */
  private async view(before: ModerationSubjectRecord): Promise<ModerationSubject> {
    const ref = { type: before.type, id: before.id };
    const key = subjectKey(ref.type, ref.id);
    const details = await this.reader.details([ref], { withReports: false });
    const subject = details.subjects.get(key) ?? before;
    return toModerationSubject(subject, {
      courseTitle: details.courseTitles.get(subject.courseId) ?? null,
      openReportCount: details.openCounts.get(key) ?? 0,
      actions: details.actions.get(key) ?? [],
      people: details.people,
    });
  }
}
