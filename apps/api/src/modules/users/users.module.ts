import { Module } from '@nestjs/common';
import { AccessModule } from '../access';
import { IdentityModule } from '../identity';
import { InstructorApplicationDecider } from './application/instructor-application.decider';
import { InstructorApplicationOwnership } from './application/instructor-application.ownership';
import { InstructorApplicationEventPublisher } from './application/ports/instructor-application-event.publisher';
import { InstructorApplicationRepository } from './application/ports/instructor-application.repository';
import { ProfileRepository } from './application/ports/profile.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { UserLock } from './application/ports/user-lock';
import { PublicProfileReader } from './application/public-profile.reader';
import { AdminGetUserQuery } from './application/use-cases/admin-get-user.query';
import { AdminSearchUsersQuery } from './application/use-cases/admin-search-users.query';
import { ApproveInstructorApplicationCommand } from './application/use-cases/approve-instructor-application.command';
import { BanUserCommand } from './application/use-cases/ban-user.command';
import { BootstrapAdminCommand } from './application/use-cases/bootstrap-admin.command';
import { GetInstructorApplicationQuery } from './application/use-cases/get-instructor-application.query';
import { GetMeQuery } from './application/use-cases/get-me.query';
import { GetMyProfileQuery } from './application/use-cases/get-my-profile.query';
import { GetPublicProfileQuery } from './application/use-cases/get-public-profile.query';
import { ListInstructorApplicationsQuery } from './application/use-cases/list-instructor-applications.query';
import { ListMyInstructorApplicationsQuery } from './application/use-cases/list-my-instructor-applications.query';
import { RejectInstructorApplicationCommand } from './application/use-cases/reject-instructor-application.command';
import { SubmitInstructorApplicationCommand } from './application/use-cases/submit-instructor-application.command';
import { UnbanUserCommand } from './application/use-cases/unban-user.command';
import { UpdateMyProfileCommand } from './application/use-cases/update-my-profile.command';
import { WithdrawInstructorApplicationCommand } from './application/use-cases/withdraw-instructor-application.command';
import { UsersFacade } from './application/users.facade';
import { KyselyInstructorApplicationRepository } from './infrastructure/kysely-instructor-application.repository';
import { KyselyProfileRepository } from './infrastructure/kysely-profile.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { KyselyUserLock } from './infrastructure/kysely-user-lock';
import { OutboxInstructorApplicationEventPublisher } from './infrastructure/outbox-instructor-application-event.publisher';
import { AdminInstructorApplicationsController } from './presentation/admin-instructor-applications.controller';
import { AdminUsersController } from './presentation/admin-users.controller';
import { InstructorApplicationsController } from './presentation/instructor-applications.controller';
import { MeController } from './presentation/me.controller';
import { MyInstructorApplicationsController } from './presentation/my-instructor-applications.controller';
import { PublicProfilesController } from './presentation/public-profiles.controller';

/**
 * users: profiles, /me, instructor applications, admin users and the admin:bootstrap CLI
 * (design §3–§8). Depends on identity and access through their facades only (users -> both,
 * no cycle). Relies on the global DatabaseModule, OutboxModule and AuthSupportModule.
 *
 * Exports the UsersFacade (Phase 2) and BootstrapAdminCommand (the CLI and its tests).
 * `InstructorApplicationOwnership` is found by access's OwnershipRegistry via DiscoveryService.
 */
@Module({
  imports: [IdentityModule, AccessModule],
  controllers: [
    MeController,
    PublicProfilesController,
    MyInstructorApplicationsController,
    InstructorApplicationsController,
    AdminInstructorApplicationsController,
    AdminUsersController,
  ],
  providers: [
    // Persistence and events
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: UserLock, useClass: KyselyUserLock },
    { provide: ProfileRepository, useClass: KyselyProfileRepository },
    { provide: InstructorApplicationRepository, useClass: KyselyInstructorApplicationRepository },
    {
      provide: InstructorApplicationEventPublisher,
      useClass: OutboxInstructorApplicationEventPublisher,
    },

    // Application services
    InstructorApplicationDecider,
    InstructorApplicationOwnership,
    PublicProfileReader,
    UsersFacade,

    // Use cases
    GetMeQuery,
    GetMyProfileQuery,
    UpdateMyProfileCommand,
    GetPublicProfileQuery,
    SubmitInstructorApplicationCommand,
    WithdrawInstructorApplicationCommand,
    ListMyInstructorApplicationsQuery,
    GetInstructorApplicationQuery,
    ListInstructorApplicationsQuery,
    ApproveInstructorApplicationCommand,
    RejectInstructorApplicationCommand,
    AdminSearchUsersQuery,
    AdminGetUserQuery,
    BanUserCommand,
    UnbanUserCommand,
    BootstrapAdminCommand,
  ],
  exports: [UsersFacade, BootstrapAdminCommand],
})
export class UsersModule {}
