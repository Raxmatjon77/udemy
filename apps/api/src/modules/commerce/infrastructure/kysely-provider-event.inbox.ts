import { Injectable } from '@nestjs/common';
import type { ProviderEventOutcome } from '@udemy/contracts';
import { claimProviderEvent, type DB, finishProviderEvent, type Transaction } from '@udemy/db';
import {
  type ProviderEventClaim,
  ProviderEventInbox,
} from '../application/ports/provider-event.inbox';

/** `commerce.provider_events` through the `@udemy/db` claim/finish ops (schema doc §8.3). */
@Injectable()
export class KyselyProviderEventInbox extends ProviderEventInbox {
  claim(trx: Transaction<DB>, event: ProviderEventClaim): Promise<boolean> {
    return claimProviderEvent(trx, event);
  }

  async finish(
    trx: Transaction<DB>,
    eventId: string,
    outcome: ProviderEventOutcome,
    orderId: string | null,
  ): Promise<void> {
    const finished = await finishProviderEvent(trx, { eventId, outcome, orderId });
    if (!finished) {
      // Claimed in this very transaction, so it cannot be finished already: a bug.
      throw new Error(`provider event ${eventId} was not claimed by this transaction`);
    }
  }
}
