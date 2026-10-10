import type { ClientApp, Permission } from '@udemy/contracts';
import { type Role, withImplicitRole } from './role';

/**
 * Granted to every authenticated principal in every app (design §4), whatever their roles.
 */
export const BASELINE: readonly Permission[] = Object.freeze([
  'profile:read:own',
  'profile:update:own',
  'session:manage:own',
] as const satisfies readonly Permission[]);

/**
 * Role -> permissions (design D4, §4). Code-defined on purpose: a permission only means
 * something together with the code that checks it, so both are reviewed in one change.
 * `Record<Role, ...>` makes a new role a compile error until it is mapped here.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  STUDENT: Object.freeze([
    'instructor_application:create:own',
    'instructor_application:read:own',
    'instructor_application:withdraw:own',
  ] as const satisfies readonly Permission[]),
  // Phase 2 (catalog & media design §8). Every `:own` entry is narrowed to the caller's own
  // rows by an ownership resolver (D9: `course` in catalog, `media_asset` in media).
  INSTRUCTOR: Object.freeze([
    // Opening a new draft course is the instructor's core job; no resource exists yet, so the
    // permission is unscoped and the new course is owned by the caller.
    'course:create',
    // The builder lists and edits only the instructor's own courses (working copy + revisions).
    'course:read:own',
    'course:update:own',
    // An author may delete their own course; the use case refuses published or in-review ones.
    'course:delete:own',
    // Only the author submits a course for review (and withdraws it), and archives/restores it.
    'course:submit:own',
    'course:archive:own',
    // Lecture videos and thumbnails are uploaded by the course author: start an upload (the
    // asset is owned by the caller), then sign parts / complete / abort only their own assets.
    'media_asset:create',
    'media_asset:upload:own',
    // The instructor follows upload/processing status of their own assets only.
    'media_asset:read:own',
  ] as const satisfies readonly Permission[]),
  ADMIN: Object.freeze([
    'user:read:any',
    'user:ban:any',
    'instructor_application:read:any',
    'instructor_application:review:any',
    'role:grant:any',
    // Moderators must see every course (drafts and submitted revisions) to review them.
    'course:read:any',
    // Review queue, approve/reject revisions, takedown/restore: moderation is an admin duty.
    'course:moderate:any',
    // The category tree is a platform-wide taxonomy, not owned by any instructor.
    'category:manage',
    // Moderators inspect any asset (status, renditions) when reviewing a course. Read-only:
    // admins never upload into or alter an instructor's assets.
    'media_asset:read:any',
  ] as const satisfies readonly Permission[]),
});

/**
 * Which roles may exercise their permissions in which app (design D6). XSS in the student
 * app therefore cannot use an admin's ADMIN permissions, and signing in to the instructor
 * or admin app requires the matching role.
 */
export const APP_ROLE_SCOPE: Readonly<Record<ClientApp, readonly Role[]>> = Object.freeze({
  student: Object.freeze(['STUDENT'] as const satisfies readonly Role[]),
  instructor: Object.freeze(['INSTRUCTOR'] as const satisfies readonly Role[]),
  admin: Object.freeze(['ADMIN'] as const satisfies readonly Role[]),
});

/** Held roles that count in `app` (the implicit STUDENT is always held). */
function rolesInScope(roles: Iterable<Role>, app: ClientApp): Role[] {
  const scope = APP_ROLE_SCOPE[app];
  return withImplicitRole(roles).filter((role) => scope.includes(role));
}

/** BASELINE ∪ permissions(roles ∩ scope(app)). STUDENT is added implicitly. */
export function effectivePermissions(
  roles: Iterable<Role>,
  app: ClientApp,
): ReadonlySet<Permission> {
  const permissions = new Set<Permission>(BASELINE);
  for (const role of rolesInScope(roles, app)) {
    for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  }
  return permissions;
}

/** True when the user holds at least one role allowed in `app`. */
export function canLoginToApp(roles: Iterable<Role>, app: ClientApp): boolean {
  return rolesInScope(roles, app).length > 0;
}
