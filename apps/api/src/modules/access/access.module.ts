import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessFacade } from './application/access.facade';
import { Authorizer } from './application/authorizer';
import { OwnershipRegistry } from './application/ownership.registry';
import { RoleEventPublisher } from './application/ports/role-event.publisher';
import { UserRoleRepository } from './application/ports/user-role.repository';
import { KyselyUserRoleRepository } from './infrastructure/kysely-user-role.repository';
import { OutboxRoleEventPublisher } from './infrastructure/outbox-role-event.publisher';
import { PoliciesGuard } from './presentation/policies.guard';
import { RouteSecurityAuditor } from './presentation/route-security.auditor';

/**
 * Roles, the code-defined permission catalog and authorization (design §3/§4).
 * Needs the global DatabaseModule, OutboxModule and AuthSupportModule.
 *
 * Importing it also installs the RouteSecurityAuditor (boot fails on unmarked routes).
 * PoliciesGuard is exported for AppModule's APP_GUARD chain only (registered by AppModule,
 * after JwtAuthGuard), e.g. `{ provide: APP_GUARD, useExisting: PoliciesGuard }`.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: UserRoleRepository, useClass: KyselyUserRoleRepository },
    { provide: RoleEventPublisher, useClass: OutboxRoleEventPublisher },
    AccessFacade,
    OwnershipRegistry,
    Authorizer,
    PoliciesGuard,
    RouteSecurityAuditor,
  ],
  exports: [AccessFacade, Authorizer, PoliciesGuard],
})
export class AccessModule {}
