import type { AccountStatus } from '@udemy/contracts';

export type { AccountStatus };

/** Public account summary (design §3 `getUserSummary`). */
export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  /** Derived from `identity.user_bans` (BANNED while an unlifted ban exists). */
  readonly status: AccountStatus;
  readonly createdAt: Date;
}

/** One ban, active (`liftedAt` null) or lifted. */
export interface BanRecord {
  readonly id: string;
  readonly userId: string;
  readonly reason: string;
  readonly bannedBy: string;
  readonly bannedAt: Date;
  readonly liftedAt: Date | null;
  readonly liftedBy: string | null;
  readonly liftReason: string | null;
}

export interface AccountStatusView {
  readonly status: AccountStatus;
  /** Present iff `status` is BANNED. */
  readonly activeBan?: BanRecord;
}

/** `searchUsers` input (admin users list). Newest first, keyset paginated. */
export interface UserSearchParams {
  /** Substring of display name or email, at least 3 characters (trigram indexes). */
  readonly q?: string;
  readonly status?: AccountStatus;
  /** Restrict to these ids (role filter, resolved by the caller through AccessFacade). */
  readonly idIn?: readonly string[];
  /** Opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
  /** 1..100. */
  readonly limit: number;
}

export interface UserSearchPage {
  readonly items: UserSummary[];
  /** null on the last page. */
  readonly nextCursor: string | null;
}

/** Reasons a caller may give `revokeAllSessions` (design §4 session state machine). */
export type BulkRevokeReason =
  'LOGOUT_ALL' | 'PASSWORD_CHANGED' | 'PASSWORD_RESET' | 'BANNED' | 'ROLE_LOST';
