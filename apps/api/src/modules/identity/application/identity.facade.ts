import { Injectable } from '@nestjs/common';
import type { DB, Executor, Transaction } from '@udemy/db';
import { parseBanReason, parseLiftReason } from '../domain/ban-reason';
import { DisplayName } from '../domain/display-name';
import { Email } from '../domain/email';
import { AccountNotFound, CannotBanSelf, NotBanned } from '../domain/identity.errors';
import { PlainPassword } from '../domain/password/plain-password';
import type {
  AccountStatusView,
  BanRecord,
  BulkRevokeReason,
  UserSearchPage,
  UserSearchParams,
  UserSummary,
} from './dto';
import { IdentityEventPublisher } from './ports/identity-event.publisher';
import { PasswordHasher } from './ports/password-hasher';
import { SecurityEventLog } from './ports/security-event.log';
import { SessionRepository } from './ports/session.repository';
import { SessionRevocationStore } from './ports/session-revocation.store';
import { UserAccountRepository } from './ports/user-account.repository';
import { UserBanRepository } from './ports/user-ban.repository';
import { UserDirectory } from './ports/user-directory';
import { assertPageLimit, decodeUserCursor, encodeUserCursor, searchPattern } from './user-search';

export interface ChangeDisplayNameCommand {
  readonly userId: string;
  readonly displayName: string;
}

export interface RevokeAllSessionsCommand {
  readonly userId: string;
  readonly reason: BulkRevokeReason;
}

export interface BanUserCommand {
  readonly userId: string;
  readonly actorId: string;
  /** 10–1000 characters. */
  readonly reason: string;
}

export interface UnbanUserCommand {
  readonly userId: string;
  readonly actorId: string;
  /** Optional, 1–1000 characters. */
  readonly reason?: string;
}

export interface ProvisionAccountCommand {
  readonly email: string;
  readonly displayName: string;
  /** Checked against the password policy (422 weak_password). */
  readonly password: string;
  /** CLI-provisioned accounts are verified by construction (design §5 BootstrapAdmin). */
  readonly emailVerified: true;
}

/**
 * Public API of the identity context for other modules (design §3). Write methods run in the
 * caller's transaction (the caller owns the unit of work); read methods accept an optional
 * executor (default: the root database).
 *
 * Writes that revoke sessions also set the Redis sid keys BEFORE the caller commits (ban
 * ordering, design §5): if Redis fails the caller's transaction must abort (503).
 */
@Injectable()
export class IdentityFacade {
  constructor(
    private readonly accounts: UserAccountRepository,
    private readonly bans: UserBanRepository,
    private readonly directory: UserDirectory,
    private readonly sessions: SessionRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly events: IdentityEventPublisher,
    private readonly revocations: SessionRevocationStore,
    private readonly hasher: PasswordHasher,
  ) {}

  /* ------------------------------------------------------------------ reads */

  /** `{ id, email, displayName, emailVerified, status, createdAt }`, or null. */
  async getUserSummary(userId: string, ex?: Executor): Promise<UserSummary | null> {
    return (await this.directory.findSummaries([userId], ex))[0] ?? null;
  }

  /** Summaries of the existing users among `userIds` (unknown ids are omitted; any order). */
  getUserSummaries(userIds: readonly string[], ex?: Executor): Promise<UserSummary[]> {
    const unique = [...new Set(userIds)];
    return unique.length === 0 ? Promise.resolve([]) : this.directory.findSummaries(unique, ex);
  }

  /**
   * Admin user search: newest first, keyset paginated. `q` matches display name or email
   * (ILIKE substring, metacharacters escaped, >= 3 characters); `status` is derived from active
   * bans; `idIn` restricts to given ids (an empty list matches nobody).
   *
   * @throws InvalidSearchParameter (422) for a short `q`, a bad `limit` or a foreign cursor
   */
  async searchUsers(params: UserSearchParams, ex?: Executor): Promise<UserSearchPage> {
    assertPageLimit(params.limit);
    const pattern = searchPattern(params.q);
    const after = params.cursor === undefined ? undefined : decodeUserCursor(params.cursor);
    if (params.idIn !== undefined && params.idIn.length === 0) {
      return { items: [], nextCursor: null };
    }
    const rows = await this.directory.search(
      {
        pattern,
        status: params.status,
        idIn: params.idIn === undefined ? undefined : [...new Set(params.idIn)],
        after,
        take: params.limit + 1,
      },
      ex,
    );
    const page = rows.slice(0, params.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => row.summary),
      nextCursor:
        rows.length > params.limit && last !== undefined ? encodeUserCursor(last.keyset) : null,
    };
  }

  /** Fresh (never from a token): gates sensitive actions (design §13). Unknown user: false. */
  async isEmailVerified(userId: string, ex?: Executor): Promise<boolean> {
    const account = await this.accounts.findById(userId, ex);
    return account !== null && account.emailVerifiedAt !== null;
  }

  /** @throws AccountNotFound (404 `user_not_found`) */
  async getAccountStatus(userId: string, ex?: Executor): Promise<AccountStatusView> {
    const account = await this.accounts.findById(userId, ex);
    if (account === null) throw new AccountNotFound();
    const activeBan = await this.bans.findActive(userId, ex);
    return activeBan === null ? { status: 'ACTIVE' } : { status: 'BANNED', activeBan };
  }

  /** Ban history, newest first. */
  listBans(userId: string, ex?: Executor): Promise<BanRecord[]> {
    return this.bans.list(userId, ex);
  }

  /** Sessions the sessions list would show (admin user detail). */
  countActiveSessions(userId: string, ex?: Executor): Promise<number> {
    return this.sessions.countActive(userId, ex);
  }

  /* ------------------------------------------------------------------ writes (caller's trx) */

  /**
   * Sets the display name and emits `DisplayNameChanged`; a no-op (no event) when unchanged.
   * @throws InvalidDisplayName (422), AccountNotFound (404)
   */
  async changeDisplayName(trx: Transaction<DB>, cmd: ChangeDisplayNameCommand): Promise<void> {
    const displayName = DisplayName.parse(cmd.displayName);
    const result = await this.accounts.updateDisplayName(trx, cmd.userId, displayName.value);
    if (result === null) throw new AccountNotFound();
    if (!result.changed) return;
    await this.events.displayNameChanged(trx, {
      userId: cmd.userId,
      displayName: displayName.value,
      changedAt: result.changedAt.toISOString(),
    });
  }

  /**
   * Revokes every active session of the user (DB) and sets their Redis sid keys (before the
   * caller commits). E.g. ROLE_LOST after `AccessFacade.revokeRole`.
   */
  async revokeAllSessions(
    trx: Transaction<DB>,
    cmd: RevokeAllSessionsCommand,
  ): Promise<{ revokedSessionIds: string[] }> {
    const revokedSessionIds = await this.sessions.revokeAllForUser(trx, cmd.userId, cmd.reason);
    await this.revocations.revokeMany(revokedSessionIds);
    return { revokedSessionIds };
  }

  /**
   * Bans the user (design §5 "Ban ordering"): per-user lock, insert the ban, revoke all
   * sessions (BANNED), `UserBanned` + USER_BANNED security event, Redis sid keys; the caller
   * commits. The "target holds ADMIN" rule is the users module's (it needs AccessFacade).
   *
   * @throws InvalidBanReason 422, CannotBanSelf 409, AccountNotFound 404, AlreadyBanned 409
   */
  async banUser(trx: Transaction<DB>, cmd: BanUserCommand): Promise<BanRecord> {
    const reason = parseBanReason(cmd.reason);
    if (cmd.userId === cmd.actorId) throw new CannotBanSelf();
    if (!(await this.accounts.lockUser(trx, cmd.userId))) throw new AccountNotFound();

    const ban = await this.bans.insert(trx, { userId: cmd.userId, bannedBy: cmd.actorId, reason });
    const revoked = await this.sessions.revokeAllForUser(trx, cmd.userId, 'BANNED');
    await this.events.userBanned(trx, {
      userId: ban.userId,
      banId: ban.id,
      reason: ban.reason,
      bannedBy: ban.bannedBy,
      bannedAt: ban.bannedAt.toISOString(),
    });
    await this.securityLog.record(
      {
        type: 'USER_BANNED',
        userId: ban.userId,
        metadata: { banId: ban.id, bannedBy: ban.bannedBy, revokedSessions: revoked.length },
      },
      trx,
    );
    await this.revocations.revokeMany(revoked);
    return ban;
  }

  /**
   * Lifts the active ban; emits `UserUnbanned` + USER_UNBANNED. Sessions stay revoked.
   * @throws InvalidBanReason 422, AccountNotFound 404, NotBanned 409
   */
  async unbanUser(trx: Transaction<DB>, cmd: UnbanUserCommand): Promise<BanRecord> {
    const liftReason = parseLiftReason(cmd.reason);
    if (!(await this.accounts.lockUser(trx, cmd.userId))) throw new AccountNotFound();
    const lifted = await this.bans.lift(trx, {
      userId: cmd.userId,
      liftedBy: cmd.actorId,
      liftReason,
    });
    if (lifted === null || lifted.liftedAt === null || lifted.liftedBy === null) {
      throw new NotBanned();
    }
    await this.events.userUnbanned(trx, {
      userId: lifted.userId,
      banId: lifted.id,
      liftedBy: lifted.liftedBy,
      liftedAt: lifted.liftedAt.toISOString(),
    });
    await this.securityLog.record(
      {
        type: 'USER_UNBANNED',
        userId: lifted.userId,
        metadata: { banId: lifted.id, liftedBy: lifted.liftedBy },
      },
      trx,
    );
    return lifted;
  }

  /**
   * Idempotent "ensure account" for the admin bootstrap CLI: creates a verified account (and
   * emits `UserRegistered`), or returns the existing one untouched (`created: false`; the
   * password is NOT changed).
   *
   * @throws InvalidEmail / InvalidDisplayName / WeakPassword (422)
   */
  async provisionAccount(
    trx: Transaction<DB>,
    cmd: ProvisionAccountCommand,
  ): Promise<{ userId: string; created: boolean }> {
    const email = Email.parse(cmd.email);
    const displayName = DisplayName.parse(cmd.displayName);
    const password = PlainPassword.create(cmd.password, { email });

    const inserted = await this.accounts.insertIfAbsent(trx, {
      email: email.value,
      displayName: displayName.value,
      passwordHash: await this.hasher.hash(password),
      emailVerified: cmd.emailVerified,
    });
    if (inserted === null) {
      const existing = await this.accounts.findByEmail(email.value, trx);
      if (existing === null) throw new AccountNotFound();
      return { userId: existing.id, created: false };
    }
    await this.events.userRegistered(trx, {
      userId: inserted.id,
      email: email.value,
      displayName: displayName.value,
      registeredAt: inserted.createdAt.toISOString(),
    });
    return { userId: inserted.id, created: true };
  }
}
