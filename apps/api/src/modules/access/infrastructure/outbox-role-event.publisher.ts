import { Injectable } from '@nestjs/common';
import {
  RoleGranted,
  type RoleGrantedPayload,
  RoleRevoked,
  type RoleRevokedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { RoleEventPublisher } from '../application/ports/role-event.publisher';

/** `access.user_role` events through the transactional outbox; aggregateId = userId. */
@Injectable()
export class OutboxRoleEventPublisher extends RoleEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async roleGranted(trx: Transaction<DB>, payload: RoleGrantedPayload): Promise<void> {
    await this.outbox.publish(trx, RoleGranted, payload.userId, payload);
  }

  async roleRevoked(trx: Transaction<DB>, payload: RoleRevokedPayload): Promise<void> {
    await this.outbox.publish(trx, RoleRevoked, payload.userId, payload);
  }
}
