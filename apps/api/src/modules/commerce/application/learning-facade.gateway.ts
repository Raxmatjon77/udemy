import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import { LearningFacade } from '../../learning';
import { type CommerceConsumption, CommerceLearning } from './ports/context-gateways';

/**
 * `CommerceLearning` over `LearningFacade.getConsumption` (Phase 5 design D8). Learning never
 * imports commerce, so `CommerceModule` imports `LearningModule` directly (no cycle).
 */
@Injectable()
export class LearningFacadeGateway extends CommerceLearning {
  constructor(private readonly learning: LearningFacade) {
    super();
  }

  getConsumption(userId: string, courseId: string, ex?: Executor): Promise<CommerceConsumption> {
    return this.learning.getConsumption(userId, courseId, ex);
  }
}
