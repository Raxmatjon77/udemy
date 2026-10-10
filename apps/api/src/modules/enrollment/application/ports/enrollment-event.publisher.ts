import type { EnrollmentGrantedPayload, EnrollmentRevokedPayload } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * `enrollment.enrollment` events through the transactional outbox (design §7, D8): written in
 * the caller's transaction, so they commit with the grant / revoke or not at all.
 * aggregateId = enrollmentId.
 */
export abstract class EnrollmentEventPublisher {
  abstract granted(trx: Transaction<DB>, payload: EnrollmentGrantedPayload): Promise<void>;
  abstract revoked(trx: Transaction<DB>, payload: EnrollmentRevokedPayload): Promise<void>;
}
