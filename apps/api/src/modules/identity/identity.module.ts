import { Module } from '@nestjs/common';
import { AppConfigService } from '../../shared/config';
import { AccessModule } from '../access';
import { AccessPermissionResolver } from './application/access-permission.resolver';
import { AccessTokenAuthenticator } from './application/access-token.authenticator';
import { GetJwksQuery } from './application/get-jwks.query';
import { IdentityFacade } from './application/identity.facade';
import { AccessTokenIssuer } from './application/ports/access-token-issuer';
import { AccessTokenVerifier } from './application/ports/access-token-verifier';
import { IdentityEventPublisher } from './application/ports/identity-event.publisher';
import { KeyStore } from './application/ports/key-store';
import { LoginEmailHasher } from './application/ports/login-email.hasher';
import { PasswordHasher } from './application/ports/password-hasher';
import { PermissionResolver } from './application/ports/permission-resolver';
import { RefreshTokenCodec } from './application/ports/refresh-token.codec';
import { ResponseTimeFloor } from './application/ports/response-time-floor';
import { SecurityEventLog } from './application/ports/security-event.log';
import { SessionRepository } from './application/ports/session.repository';
import { SessionRevocationStore } from './application/ports/session-revocation.store';
import { TransactionRunner } from './application/ports/transaction-runner';
import { UserAccountRepository } from './application/ports/user-account.repository';
import { UserBanRepository } from './application/ports/user-ban.repository';
import { UserDirectory } from './application/ports/user-directory';
import { ListMySessionsQuery } from './application/use-cases/list-my-sessions.query';
import { LoginCommand } from './application/use-cases/login.command';
import { LogoutCommand } from './application/use-cases/logout.command';
import { LogoutAllSessionsCommand } from './application/use-cases/logout-all-sessions.command';
import { RefreshSessionCommand } from './application/use-cases/refresh-session.command';
import { RegisterUserCommand } from './application/use-cases/register-user.command';
import { RevokeSessionCommand } from './application/use-cases/revoke-session.command';
import { HmacLoginEmailHasher } from './infrastructure/crypto/hmac-login-email.hasher';
import { HmacRefreshTokenCodec } from './infrastructure/crypto/hmac-refresh-token.codec';
import { OutboxIdentityEventPublisher } from './infrastructure/events/outbox-identity-event.publisher';
import { FileKeyStore } from './infrastructure/keys/file-key.store';
import {
  ARGON2_PARAMS,
  Argon2PasswordHasher,
  DEFAULT_ARGON2_PARAMS,
} from './infrastructure/password/argon2-password.hasher';
import { KyselySecurityEventLog } from './infrastructure/persistence/kysely-security-event.log';
import { KyselySessionRepository } from './infrastructure/persistence/kysely-session.repository';
import { KyselyTransactionRunner } from './infrastructure/persistence/kysely-transaction-runner';
import { KyselyUserAccountRepository } from './infrastructure/persistence/kysely-user-account.repository';
import { KyselyUserBanRepository } from './infrastructure/persistence/kysely-user-ban.repository';
import { KyselyUserDirectory } from './infrastructure/persistence/kysely-user-directory';
import { RedisSessionRevocationStore } from './infrastructure/redis/redis-session-revocation.store';
import { SleepResponseTimeFloor } from './infrastructure/timing/sleep-response-time-floor';
import { JoseAccessTokenIssuer } from './infrastructure/tokens/jose-access-token.issuer';
import { JoseAccessTokenVerifier } from './infrastructure/tokens/jose-access-token.verifier';
import { AuthController } from './presentation/auth.controller';
import { ClientAuthGuard } from './presentation/guards/client-auth.guard';
import { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
import { JwksController } from './presentation/jwks.controller';
import { SessionsController } from './presentation/sessions.controller';

/**
 * identity: credentials, sessions, access tokens, JWKS and the request-authentication guards.
 * Imports AccessModule (identity -> access, design §1). Relies on the global AppConfigModule,
 * DatabaseModule, RedisModule (REDIS + RateLimiter), OutboxModule and AuthSupportModule.
 *
 * Exports only what other modules and AppModule need: the facade, the two global guards and
 * the revocation store. Ports and adapters stay private.
 */
@Module({
  imports: [AccessModule],
  controllers: [JwksController, AuthController, SessionsController],
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
    { provide: RefreshTokenCodec, useClass: HmacRefreshTokenCodec },
    { provide: LoginEmailHasher, useClass: HmacLoginEmailHasher },

    // Persistence and events
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: UserAccountRepository, useClass: KyselyUserAccountRepository },
    { provide: UserBanRepository, useClass: KyselyUserBanRepository },
    { provide: UserDirectory, useClass: KyselyUserDirectory },
    { provide: SessionRepository, useClass: KyselySessionRepository },
    { provide: SecurityEventLog, useClass: KyselySecurityEventLog },
    { provide: IdentityEventPublisher, useClass: OutboxIdentityEventPublisher },
    { provide: ResponseTimeFloor, useClass: SleepResponseTimeFloor },

    // Use cases and the facade
    RegisterUserCommand,
    LoginCommand,
    RefreshSessionCommand,
    LogoutCommand,
    LogoutAllSessionsCommand,
    RevokeSessionCommand,
    ListMySessionsQuery,
    IdentityFacade,

    // Request authentication
    RedisSessionRevocationStore,
    { provide: SessionRevocationStore, useExisting: RedisSessionRevocationStore },
    { provide: PermissionResolver, useClass: AccessPermissionResolver },
    AccessTokenAuthenticator,
    ClientAuthGuard,
    JwtAuthGuard,
  ],
  exports: [IdentityFacade, ClientAuthGuard, JwtAuthGuard, SessionRevocationStore],
})
export class IdentityModule {}
