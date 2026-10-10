import { Injectable, Logger } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { WorkerConfigService } from '../../shared/config';
import {
  deriveOneTimeToken,
  hashOneTimeToken,
  ONE_TIME_TOKEN_TTL_MS,
  type OneTimeTokenPurpose,
  sameEmail,
} from './one-time-token';
import { OneTimeTokenStore } from './one-time-token.store';

export interface IssueOneTimeTokenInput {
  /** Outbox event id: the idempotency key (`source_event_id`) and the HMAC input. */
  readonly eventId: string;
  readonly userId: string;
  readonly purpose: OneTimeTokenPurpose;
  /** The address the event asks to mail. */
  readonly email: string;
  /** The event's `requestedAt` (api SQL now()). */
  readonly requestedAt: Date;
}

export type IssueSkipReason =
  'user_missing' | 'email_changed' | 'expired' | 'superseded' | 'already_used' | 'secret_rotated';

export type IssueOneTimeTokenResult =
  | { readonly kind: 'issued'; readonly rawToken: string; readonly expiresAt: Date }
  | { readonly kind: 'skipped'; readonly reason: IssueSkipReason };

/**
 * `IssueOneTimeToken` (design §5, D10, §14), run in the handler's transaction (which already
 * holds the processed_events claim):
 *
 * 1. lock the user row (`FOR NO KEY UPDATE`, the per-user mutex of schema doc §6) and read
 *    `now()`; skip if the user is gone or their email is no longer the event's email;
 * 2. `expires_at = requested_at + TTL`; skip if that is already past (very late redelivery);
 * 3. skip if a token of this purpose with a later `requested_at` exists (out of order);
 * 4. invalidate the other live tokens of this purpose (`source_event_id <> eventId`, so a
 *    redelivery never kills its own token);
 * 5. `INSERT ... ON CONFLICT (source_event_id) DO NOTHING` with `sha256(raw)` only;
 * 6. re-read the row of this event: a redelivery returns the SAME raw token while it is still
 *    live, and skips once it was consumed or superseded.
 *
 * The raw token is returned to the caller for the email and never stored.
 */
@Injectable()
export class IssueOneTimeToken {
  private readonly logger = new Logger(IssueOneTimeToken.name);

  constructor(
    private readonly store: OneTimeTokenStore,
    private readonly config: WorkerConfigService,
  ) {}

  async execute(
    trx: Transaction<DB>,
    input: IssueOneTimeTokenInput,
  ): Promise<IssueOneTimeTokenResult> {
    const { eventId, userId, purpose } = input;
    const owner = await this.store.lockOwner(trx, userId);
    if (owner === null) return this.skip(input, 'user_missing');
    if (!sameEmail(owner.email, input.email)) return this.skip(input, 'email_changed');

    const expiresAt = new Date(input.requestedAt.getTime() + ONE_TIME_TOKEN_TTL_MS[purpose]);
    if (expiresAt.getTime() <= owner.now.getTime()) return this.skip(input, 'expired');
    if (await this.store.hasNewerRequest(trx, userId, purpose, input.requestedAt)) {
      return this.skip(input, 'superseded');
    }

    await this.store.invalidateOthers(trx, userId, purpose, eventId);
    const rawToken = deriveOneTimeToken(this.config.get('EMAIL_TOKEN_SECRET'), eventId, purpose);
    const tokenHash = hashOneTimeToken(rawToken);
    await this.store.insertIfAbsent(trx, {
      userId,
      purpose,
      tokenHash,
      email: owner.email,
      sourceEventId: eventId,
      requestedAt: input.requestedAt,
      expiresAt,
    });

    const stored = await this.store.findBySourceEvent(trx, eventId);
    if (stored === null) throw new Error(`One-time token for event ${eventId} was not stored`);
    if (!stored.live) return this.skip(input, 'already_used');
    // Issued earlier with another EMAIL_TOKEN_SECRET: this raw token would not match the row.
    if (!stored.tokenHash.equals(tokenHash)) return this.skip(input, 'secret_rotated');
    return { kind: 'issued', rawToken, expiresAt };
  }

  private skip(input: IssueOneTimeTokenInput, reason: IssueSkipReason): IssueOneTimeTokenResult {
    this.logger.log(
      { eventId: input.eventId, userId: input.userId, purpose: input.purpose, reason },
      'One-time token not issued; no email sent',
    );
    return { kind: 'skipped', reason };
  }
}
