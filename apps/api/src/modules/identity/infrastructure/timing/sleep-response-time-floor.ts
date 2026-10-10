import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { ResponseTimeFloor } from '../../application/ports/response-time-floor';

/** Waits out the remainder of the floor after `work` settles (success or failure). */
@Injectable()
export class SleepResponseTimeFloor extends ResponseTimeFloor {
  async run<T>(minimumMs: number, work: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      const remaining = minimumMs - (performance.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    }
  }
}
