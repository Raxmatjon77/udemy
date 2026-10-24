import { Injectable, Logger } from '@nestjs/common';
import { realtimeCourseRoom } from '@udemy/contracts';
import { RealtimeEmitter } from '../../../shared/realtime';
import { type QaHint, QaHints } from '../application/ports/qa-hints';

/**
 * `qa.changed` to the course room `c:{courseId}` through the shared `RealtimeEmitter` (Redis
 * pub/sub, reaches every replica). Called after the commit; a failure (Redis down) is logged
 * and swallowed: the write already succeeded, and clients refetch on their next view or
 * reconnect.
 */
@Injectable()
export class RealtimeQaHints extends QaHints {
  private readonly logger = new Logger(RealtimeQaHints.name);

  constructor(private readonly emitter: RealtimeEmitter) {
    super();
  }

  async changed(hint: QaHint): Promise<void> {
    try {
      await this.emitter.emit(realtimeCourseRoom(hint.courseId), 'qa.changed', {
        courseId: hint.courseId,
        questionId: hint.questionId,
        lectureId: hint.lectureId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `qa.changed hint for question ${hint.questionId} of course ${hint.courseId} not delivered: ${reason}`,
      );
    }
  }
}
