export { IdentityModule } from './identity.module';
// TODO(T8): export { IdentityFacade } from './application/identity.facade';

// Global guards, for AppModule only: `{ provide: APP_GUARD, useExisting: ClientAuthGuard }`.
export { ClientAuthGuard } from './presentation/guards/client-auth.guard';
export { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
// For main.ts/setupApp: routes served outside the global `api` prefix (JWKS).
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
