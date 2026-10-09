import { z } from 'zod';

/**
 * The permission catalog: every permission the code base checks, in the format
 * `resource:action[:own|:any]` (design D4, §4).
 *
 * - `:own` lets the principal act on resources they own (resolved by an ownership resolver).
 * - `:any` lets the principal act on every resource of that type.
 *
 * This file only lists *which* permissions exist. The role -> permission map, the
 * BASELINE set and the app -> role scope live in the api's `access` domain
 * (`apps/api/src/modules/access/domain`), because granting a permission is a server-side
 * authorization decision that must be reviewed together with the code that enforces it.
 * Add new entries here in the same change that introduces the check (Phase 2 adds the
 * `course:*` permissions).
 */
export const PERMISSIONS = [
  // Baseline: every authenticated principal, in any app.
  'profile:read:own',
  'profile:update:own',
  'session:manage:own',
  // STUDENT
  'instructor_application:create:own',
  'instructor_application:read:own',
  'instructor_application:withdraw:own',
  // ADMIN
  'user:read:any',
  'user:ban:any',
  'instructor_application:read:any',
  'instructor_application:review:any',
  'role:grant:any',
] as const;

/** Compile-time guard: every catalog entry must follow `resource:action[:own|:any]`. */
type PermissionFormat = `${string}:${string}` | `${string}:${string}:${'own' | 'any'}`;
type AssertFormat<T extends PermissionFormat> = T;
export type Permission = AssertFormat<(typeof PERMISSIONS)[number]>;

export const PermissionSchema = z.enum(PERMISSIONS);

/** Runtime format of a permission string; used by tests and boot-time checks. */
export const PERMISSION_FORMAT = /^[a-z][a-z_]*:[a-z][a-z_]*(?::(?:own|any))?$/;

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}
