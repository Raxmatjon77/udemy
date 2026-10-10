import type { ClientApp, Permission, Role } from '@udemy/contracts';
import type { Principal } from '../../../../shared/auth';
import { InstructorApplicationDecider } from '../instructor-application.decider';
import { InstructorApplicationOwnership } from '../instructor-application.ownership';
import { PublicProfileReader } from '../public-profile.reader';
import { AdminGetUserQuery } from '../use-cases/admin-get-user.query';
import { AdminSearchUsersQuery } from '../use-cases/admin-search-users.query';
import { ApproveInstructorApplicationCommand } from '../use-cases/approve-instructor-application.command';
import { BanUserCommand } from '../use-cases/ban-user.command';
import { BootstrapAdminCommand } from '../use-cases/bootstrap-admin.command';
import { GetInstructorApplicationQuery } from '../use-cases/get-instructor-application.query';
import { GetMeQuery } from '../use-cases/get-me.query';
import { GetMyProfileQuery } from '../use-cases/get-my-profile.query';
import { GetPublicProfileQuery } from '../use-cases/get-public-profile.query';
import { ListInstructorApplicationsQuery } from '../use-cases/list-instructor-applications.query';
import { ListMyInstructorApplicationsQuery } from '../use-cases/list-my-instructor-applications.query';
import { RejectInstructorApplicationCommand } from '../use-cases/reject-instructor-application.command';
import { SubmitInstructorApplicationCommand } from '../use-cases/submit-instructor-application.command';
import { UnbanUserCommand } from '../use-cases/unban-user.command';
import { UpdateMyProfileCommand } from '../use-cases/update-my-profile.command';
import { WithdrawInstructorApplicationCommand } from '../use-cases/withdraw-instructor-application.command';
import { UsersFacade } from '../users.facade';
import {
  FakeAccess,
  FakeClock,
  FakeEventPublisher,
  FakeIdentity,
  FakeInstructorApplicationRepository,
  FakeProfileRepository,
  FakeTransactionRunner,
  FakeUserLock,
} from './users.fakes';

/** Every users use case wired to the in-memory fakes (one fresh world per call). */
export function createUsersHarness() {
  const clock = new FakeClock();
  const identity = new FakeIdentity(clock);
  const access = new FakeAccess();
  const applications = new FakeInstructorApplicationRepository(clock);
  const profiles = new FakeProfileRepository();
  const events = new FakeEventPublisher();
  const tx = new FakeTransactionRunner();
  const lock = new FakeUserLock((id) => identity.accounts.has(id));
  const decider = new InstructorApplicationDecider(applications);
  const reader = new PublicProfileReader(identity.asFacade(), access.asFacade(), profiles);

  return {
    clock,
    identity,
    access,
    applications,
    profiles,
    events,
    tx,
    lock,
    getMe: new GetMeQuery(identity.asFacade(), access.asFacade(), profiles),
    getMyProfile: new GetMyProfileQuery(identity.asFacade(), profiles),
    updateMyProfile: new UpdateMyProfileCommand(identity.asFacade(), profiles, tx),
    getPublicProfile: new GetPublicProfileQuery(reader),
    facade: new UsersFacade(reader),
    submit: new SubmitInstructorApplicationCommand(
      identity.asFacade(),
      access.asFacade(),
      applications,
      decider,
      events,
      tx,
    ),
    withdraw: new WithdrawInstructorApplicationCommand(decider, events, tx),
    approve: new ApproveInstructorApplicationCommand(decider, access.asFacade(), events, tx),
    reject: new RejectInstructorApplicationCommand(decider, events, tx),
    listMine: new ListMyInstructorApplicationsQuery(applications),
    getApplication: new GetInstructorApplicationQuery(applications, identity.asFacade()),
    listQueue: new ListInstructorApplicationsQuery(applications, identity.asFacade()),
    ownership: new InstructorApplicationOwnership(applications),
    searchUsers: new AdminSearchUsersQuery(identity.asFacade(), access.asFacade()),
    getUser: new AdminGetUserQuery(identity.asFacade(), access.asFacade()),
    ban: new BanUserCommand(identity.asFacade(), access.asFacade(), lock, tx),
    unban: new UnbanUserCommand(identity.asFacade(), tx),
    bootstrapAdmin: new BootstrapAdminCommand(identity.asFacade(), access.asFacade(), tx),
  };
}

export type UsersHarness = ReturnType<typeof createUsersHarness>;

export function principalOf(
  userId: string,
  options: { app?: ClientApp; roles?: Role[]; permissions?: Permission[] } = {},
): Principal {
  return {
    userId,
    sessionId: '0199d0a0-0000-7000-8000-0000000000ff',
    app: options.app ?? 'student',
    roles: options.roles ?? ['STUDENT'],
    permissions: new Set(options.permissions ?? []),
    tokenId: 'jti',
  };
}

export const VALID_FORM = {
  motivation: 'I have taught programming for ten years and would love to teach here. '.repeat(2),
  expertise: 'TypeScript',
  experienceLevel: 'PROFESSIONAL',
} as const;

export const REJECTION_REASON = 'Please add more detail about your teaching.';
