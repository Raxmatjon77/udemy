import { Injectable } from '@nestjs/common';
import {
  DisplayNameChanged,
  type DisplayNameChangedPayload,
  EmailVerificationRequested,
  type EmailVerificationRequestedPayload,
  EmailVerified,
  type EmailVerifiedPayload,
  PasswordChanged,
  type PasswordChangedPayload,
  PasswordResetRequested,
  type PasswordResetRequestedPayload,
  SessionCompromiseDetected,
  type SessionCompromiseDetectedPayload,
  SignupAttemptedForExistingEmail,
  type SignupAttemptedForExistingEmailPayload,
  UserBanned,
  type UserBannedPayload,
  UserRegistered,
  type UserRegisteredPayload,
  UserUnbanned,
  type UserUnbannedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../../shared/outbox';
import { IdentityEventPublisher } from '../../application/ports/identity-event.publisher';

/** `identity.user` events through the transactional outbox; aggregateId = userId. */
@Injectable()
export class OutboxIdentityEventPublisher extends IdentityEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async userRegistered(trx: Transaction<DB>, payload: UserRegisteredPayload): Promise<void> {
    await this.outbox.publish(trx, UserRegistered, payload.userId, payload);
  }

  async emailVerificationRequested(
    trx: Transaction<DB>,
    payload: EmailVerificationRequestedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, EmailVerificationRequested, payload.userId, payload);
  }

  async signupAttemptedForExistingEmail(
    trx: Transaction<DB>,
    payload: SignupAttemptedForExistingEmailPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, SignupAttemptedForExistingEmail, payload.userId, payload);
  }

  async sessionCompromiseDetected(
    trx: Transaction<DB>,
    payload: SessionCompromiseDetectedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, SessionCompromiseDetected, payload.userId, payload);
  }

  async displayNameChanged(
    trx: Transaction<DB>,
    payload: DisplayNameChangedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, DisplayNameChanged, payload.userId, payload);
  }

  async userBanned(trx: Transaction<DB>, payload: UserBannedPayload): Promise<void> {
    await this.outbox.publish(trx, UserBanned, payload.userId, payload);
  }

  async userUnbanned(trx: Transaction<DB>, payload: UserUnbannedPayload): Promise<void> {
    await this.outbox.publish(trx, UserUnbanned, payload.userId, payload);
  }

  async emailVerified(trx: Transaction<DB>, payload: EmailVerifiedPayload): Promise<void> {
    await this.outbox.publish(trx, EmailVerified, payload.userId, payload);
  }

  async passwordResetRequested(
    trx: Transaction<DB>,
    payload: PasswordResetRequestedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, PasswordResetRequested, payload.userId, payload);
  }

  async passwordChanged(trx: Transaction<DB>, payload: PasswordChangedPayload): Promise<void> {
    await this.outbox.publish(trx, PasswordChanged, payload.userId, payload);
  }
}
