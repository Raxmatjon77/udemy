import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';

export interface RefundEligibilityInput {
  readonly userId: string;
  readonly courseId: string;
  readonly orderLineId: string;
}

/**
 * The Phase 5 consumption rule (design D11: "≤ 30% consumed"): a non-null objection sends a
 * student request to admin review instead of auto-approving it. It never blocks a request.
 */
export abstract class RefundEligibilityPolicy {
  abstract objection(input: RefundEligibilityInput, ex: Executor): Promise<string | null>;
}

/** Phase 4 binding: there is no progress data yet, so nothing objects. */
@Injectable()
export class NoConsumptionData extends RefundEligibilityPolicy {
  objection(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
