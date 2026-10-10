import { Injectable } from '@nestjs/common';
import {
  CourseCreated,
  type CourseCreatedPayload,
  CourseDeleted,
  type CourseDeletedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { CatalogEventPublisher } from '../application/ports/catalog-event.publisher';

/** `catalog.course` events through the transactional outbox; key = courseId. */
@Injectable()
export class OutboxCatalogEventPublisher extends CatalogEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async courseCreated(trx: Transaction<DB>, payload: CourseCreatedPayload): Promise<void> {
    await this.outbox.publish(trx, CourseCreated, payload.courseId, payload);
  }

  async courseDeleted(trx: Transaction<DB>, payload: CourseDeletedPayload): Promise<void> {
    await this.outbox.publish(trx, CourseDeleted, payload.courseId, payload);
  }
}
