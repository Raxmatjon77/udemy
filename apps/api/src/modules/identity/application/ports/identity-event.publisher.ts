import type {
  DisplayNameChangedPayload,
  EmailVerificationRequestedPayload,
  EmailVerifiedPayload,
  PasswordChangedPayload,
  PasswordResetRequestedPayload,
  SessionCompromiseDetectedPayload,
  SignupAttemptedForExistingEmailPayload,
  UserBannedPayload,
  UserRegisteredPayload,
  UserUnbannedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Port for the `identity.user` outbox events (aggregateId = userId, so the topic is ordered
 * per user). Every method writes inside the caller's transaction.
 */
export abstract class IdentityEventPublisher {
  abstract userRegistered(trx: Transaction<DB>, payload: UserRegisteredPayload): Promise<void>;
  abstract emailVerificationRequested(
    trx: Transaction<DB>,
    payload: EmailVerificationRequestedPayload,
  ): Promise<void>;
  abstract signupAttemptedForExistingEmail(
    trx: Transaction<DB>,
    payload: SignupAttemptedForExistingEmailPayload,
  ): Promise<void>;
  abstract sessionCompromiseDetected(
    trx: Transaction<DB>,
    payload: SessionCompromiseDetectedPayload,
  ): Promise<void>;
  abstract displayNameChanged(
    trx: Transaction<DB>,
    payload: DisplayNameChangedPayload,
  ): Promise<void>;
  abstract userBanned(trx: Transaction<DB>, payload: UserBannedPayload): Promise<void>;
  abstract userUnbanned(trx: Transaction<DB>, payload: UserUnbannedPayload): Promise<void>;
  abstract emailVerified(trx: Transaction<DB>, payload: EmailVerifiedPayload): Promise<void>;
  abstract passwordResetRequested(
    trx: Transaction<DB>,
    payload: PasswordResetRequestedPayload,
  ): Promise<void>;
  abstract passwordChanged(trx: Transaction<DB>, payload: PasswordChangedPayload): Promise<void>;
}
