import { Module } from '@nestjs/common';
import { AppConfigService } from '../../shared/config';
import { AccessModule } from '../access';
import { AccessPermissionResolver } from './application/access-permission.resolver';
import { AccessTokenAuthenticator } from './application/access-token.authenticator';
import { GetJwksQuery } from './application/get-jwks.query';
import { AccessTokenIssuer } from './application/ports/access-token-issuer';
import { AccessTokenVerifier } from './application/ports/access-token-verifier';
import { KeyStore } from './application/ports/key-store';
import { PasswordHasher } from './application/ports/password-hasher';
import { PermissionResolver } from './application/ports/permission-resolver';
import { SessionRevocationStore } from './application/ports/session-revocation.store';
import { FileKeyStore } from './infrastructure/keys/file-key.store';
import {
  ARGON2_PARAMS,
  Argon2PasswordHasher,
  DEFAULT_ARGON2_PARAMS,
} from './infrastructure/password/argon2-password.hasher';
import { RedisSessionRevocationStore } from './infrastructure/redis/redis-session-revocation.store';
import { JoseAccessTokenIssuer } from './infrastructure/tokens/jose-access-token.issuer';
import { JoseAccessTokenVerifier } from './infrastructure/tokens/jose-access-token.verifier';
import { ClientAuthGuard } from './presentation/guards/client-auth.guard';
import { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
import { JwksController } from './presentation/jwks.controller';

/**
 * identity: credentials, access tokens, JWKS and the request-authentication guards.
 * Imports AccessModule (identity -> access, design §1). Relies on the global AppConfigModule,
 * RedisModule and AuthSupportModule (and, through AccessModule, DatabaseModule + OutboxModule).
 *
 * TODO(T8): IdentityFacade, the session use cases and their controllers.
 */
@Module({
  imports: [AccessModule],
  controllers: [JwksController],
  providers: [
    // Passwords
    { provide: ARGON2_PARAMS, useValue: DEFAULT_ARGON2_PARAMS },
    Argon2PasswordHasher,
    { provide: PasswordHasher, useExisting: Argon2PasswordHasher },

    // Keys and tokens. The key store loads at boot; a missing active key fails startup.
    {
      provide: FileKeyStore,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Promise<FileKeyStore> =>
        FileKeyStore.load({
          dir: config.get('JWT_KEYS_DIR'),
          activeKid: config.get('JWT_ACTIVE_KID'),
        }),
    },
    { provide: KeyStore, useExisting: FileKeyStore },
    JoseAccessTokenIssuer,
    { provide: AccessTokenIssuer, useExisting: JoseAccessTokenIssuer },
    JoseAccessTokenVerifier,
    { provide: AccessTokenVerifier, useExisting: JoseAccessTokenVerifier },
    GetJwksQuery,

    // Request authentication
    RedisSessionRevocationStore,
    { provide: SessionRevocationStore, useExisting: RedisSessionRevocationStore },
    { provide: PermissionResolver, useClass: AccessPermissionResolver },
    AccessTokenAuthenticator,
    ClientAuthGuard,
    JwtAuthGuard,
  ],
  exports: [ClientAuthGuard, JwtAuthGuard, SessionRevocationStore],
})
export class IdentityModule {}
