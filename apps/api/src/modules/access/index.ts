// Public facade of the access context: the only file other modules may import.
export { AccessModule } from './access.module';
export { AccessFacade } from './application/access.facade';
export { Authorizer, type AuthorizationSubject } from './application/authorizer';
export type {
  AuthorizationDecision,
  GrantRoleCommand,
  RevokeRoleCommand,
  RoleChangeResult,
} from './application/access.types';
export { PoliciesGuard } from './presentation/policies.guard'; // for AppModule only
export {
  type NonBffRoute,
  RouteSecurityAuditor,
  RouteSecurityError,
  type RouteSecurityFinding,
} from './presentation/route-security.auditor';
export { RoleNotAssignable, UserNotFound } from './domain/access.errors';
export type { AssignableRole, Role } from './domain/role';
