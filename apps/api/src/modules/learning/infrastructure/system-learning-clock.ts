import { Injectable } from '@nestjs/common';
import { LearningClock } from '../application/ports/learning-clock';

/** The process clock (`Date.now()`). */
@Injectable()
export class SystemLearningClock extends LearningClock {
  nowMs(): number {
    return Date.now();
  }
}
