import type { AccountStatus } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import type { UserSummary } from '../dto';

/** Keyset position: the last row of the previous page (`created_at` kept to the microsecond). */
export interface UserKeyset {
  /** `created_at` as ISO 8601 with microseconds, e.g. `2026-10-10T09:00:00.123456Z`. */
  readonly createdAt: string;
  readonly id: string;
}

export interface UserSearchFilter {
  /** Already escaped LIKE pattern, e.g. `%jane%`. */
  readonly pattern?: string;
  readonly status?: AccountStatus;
  readonly idIn?: readonly string[];
  readonly after?: UserKeyset;
  /** Rows to fetch (the caller asks for limit + 1 to detect a next page). */
  readonly take: number;
}

export interface UserSearchRow {
  readonly summary: UserSummary;
  readonly keyset: UserKeyset;
}

/** Read model over `identity.users` + `identity.user_bans` for summaries and admin search. */
export abstract class UserDirectory {
  abstract findSummaries(userIds: readonly string[], ex?: Executor): Promise<UserSummary[]>;

  /** `ORDER BY created_at DESC, id DESC`. */
  abstract search(filter: UserSearchFilter, ex?: Executor): Promise<UserSearchRow[]>;
}
