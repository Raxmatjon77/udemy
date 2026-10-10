// Public facade of the identity context: the only file other modules may import.
export { IdentityModule } from './identity.module';
export {
  IdentityFacade,
  type BanUserCommand,
  type ChangeDisplayNameCommand,
  type ProvisionAccountCommand,
  type RevokeAllSessionsCommand,
  type UnbanUserCommand,
} from './application/identity.facade';
export type {
  AccountStatus,
  AccountStatusView,
  BanRecord,
  BulkRevokeReason,
  UserSearchPage,
  UserSearchParams,
  UserSummary,
} from './application/dto';
export { AccountNotFound, AlreadyBanned, CannotBanSelf, NotBanned } from './domain/identity.errors';

// Global guards, for AppModule only: `{ provide: APP_GUARD, useExisting: ClientAuthGuard }`.
export { ClientAuthGuard } from './presentation/guards/client-auth.guard';
export { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
// For setupApp: routes served outside the global `api` prefix (JWKS).
export { IDENTITY_PREFIX_EXCLUSIONS, JWKS_PATH } from './presentation/jwks.controller';

// Access-token revocation (logout, ban); also exported by IdentityModule.
export { SessionRevocationStore } from './application/ports/session-revocation.store';

// Identity ports (types only: other modules go through the facade, never the providers).
export type { PasswordHasher } from './application/ports/password-hasher';
export type {
  AccessTokenIssuer,
  AccessTokenSubject,
  IssuedAccessToken,
} from './application/ports/access-token-issuer';
export type { AccessTokenVerifier } from './application/ports/access-token-verifier';
export type { AccessTokenClaims } from './domain/access-token';
