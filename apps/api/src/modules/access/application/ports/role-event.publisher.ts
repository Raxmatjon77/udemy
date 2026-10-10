import type { RoleGrantedPayload, RoleRevokedPayload } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/** Port for the `access.user_role` outbox events; writes inside the caller's transaction. */
export abstract class RoleEventPublisher {
  abstract roleGranted(trx: Transaction<DB>, payload: RoleGrantedPayload): Promise<void>;
  abstract roleRevoked(trx: Transaction<DB>, payload: RoleRevokedPayload): Promise<void>;
}
