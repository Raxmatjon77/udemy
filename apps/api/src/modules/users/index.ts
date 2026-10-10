// Public facade of the users context: the only file other modules may import.
export { UsersModule } from './users.module';
export { UsersFacade } from './application/users.facade';
export type { PublicProfile } from '@udemy/contracts';

// For the admin:bootstrap CLI entry point and its tests.
export {
  BootstrapAdminCommand,
  type BootstrapAdminInput,
  type BootstrapAdminResult,
} from './application/use-cases/bootstrap-admin.command';
