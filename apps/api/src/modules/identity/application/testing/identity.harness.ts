import type { Role } from '@udemy/contracts';
import { IdentityFacade } from '../identity.facade';
import type { PasswordHasher } from '../ports/password-hasher';
import { ListMySessionsQuery } from '../use-cases/list-my-sessions.query';
import { LoginCommand } from '../use-cases/login.command';
import { LogoutCommand } from '../use-cases/logout.command';
import { LogoutAllSessionsCommand } from '../use-cases/logout-all-sessions.command';
import { RefreshSessionCommand } from '../use-cases/refresh-session.command';
import { RegisterUserCommand } from '../use-cases/register-user.command';
import { RevokeSessionCommand } from '../use-cases/revoke-session.command';
import {
  FakeAccessTokenIssuer,
  fakeAccessFacade,
  FakeClock,
  FakeLoginEmailHasher,
  FakePasswordHasher,
  FakeRefreshTokenCodec,
  FakeRevocations,
  FakeTransactionRunner,
  InMemoryIdentityStore,
  InMemoryRateLimiter,
  InMemorySessions,
  InMemoryUserAccounts,
  InMemoryUserBans,
  InMemoryUserDirectory,
  RecordingEventPublisher,
  RecordingResponseFloor,
  RecordingSecurityLog,
} from './identity.fakes';

/** Every identity use case wired to in-memory fakes that share one store and one clock. */
export function createIdentityHarness(options: { hasher?: PasswordHasher } = {}) {
  const clock = new FakeClock();
  const store = new InMemoryIdentityStore(clock);
  const accounts = new InMemoryUserAccounts(store);
  const bans = new InMemoryUserBans(store);
  const directory = new InMemoryUserDirectory(store);
  const sessions = new InMemorySessions(clock);
  const securityLog = new RecordingSecurityLog();
  const events = new RecordingEventPublisher();
  const revocations = new FakeRevocations();
  const limiter = new InMemoryRateLimiter();
  const fakeHasher = new FakePasswordHasher();
  const hasher = options.hasher ?? fakeHasher;
  const refreshTokens = new FakeRefreshTokenCodec();
  const emailHasher = new FakeLoginEmailHasher();
  const accessTokens = new FakeAccessTokenIssuer(clock);
  const floor = new RecordingResponseFloor();
  const tx = new FakeTransactionRunner();
  const roles = new Map<string, Role[]>();
  const access = fakeAccessFacade(roles);
  const rateLimiter = limiter.asRateLimiter();

  return {
    clock,
    store,
    accounts,
    bans,
    directory,
    sessions,
    securityLog,
    events,
    revocations,
    limiter,
    fakeHasher,
    hasher,
    refreshTokens,
    emailHasher,
    accessTokens,
    floor,
    tx,
    roles,
    access,
    register: new RegisterUserCommand(accounts, events, hasher, rateLimiter, tx, floor),
    login: new LoginCommand(
      accounts,
      bans,
      sessions,
      securityLog,
      hasher,
      emailHasher,
      refreshTokens,
      accessTokens,
      access,
      rateLimiter,
      tx,
    ),
    refresh: new RefreshSessionCommand(
      sessions,
      accounts,
      securityLog,
      events,
      revocations,
      refreshTokens,
      accessTokens,
      access,
      tx,
    ),
    logout: new LogoutCommand(sessions, securityLog, revocations, refreshTokens, tx),
    logoutAll: new LogoutAllSessionsCommand(sessions, securityLog, revocations, tx),
    revokeSession: new RevokeSessionCommand(sessions, securityLog, revocations, tx),
    listSessions: new ListMySessionsQuery(sessions),
    facade: new IdentityFacade(
      accounts,
      bans,
      directory,
      sessions,
      securityLog,
      events,
      revocations,
      hasher,
    ),
  };
}

export type IdentityHarness = ReturnType<typeof createIdentityHarness>;

export const PASSWORD = 'correct horse battery';

/** An account whose password is PASSWORD (fake hash), optionally with explicit roles. */
export function seedAccount(
  h: IdentityHarness,
  input: { email?: string; roles?: Role[]; verified?: boolean; passwordHash?: string } = {},
): string {
  const id = h.store.addAccount({
    email: input.email ?? `user-${h.store.accounts.size + 1}@example.com`,
    passwordHash: input.passwordHash ?? FakePasswordHasher.hashOf(PASSWORD),
    verified: input.verified,
  });
  if (input.roles !== undefined) h.roles.set(id, input.roles);
  return id;
}
