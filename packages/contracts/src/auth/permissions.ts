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
 * Add new entries here in the same change that introduces the check.
 *
 * Phase 2 (catalog & media design §8) adds `course:*`, `category:manage` and `media_asset:*`.
 * Sections and lectures have no permissions of their own: they are reached through nested
 * course routes and checked with the course policy (design finding 2, Q7).
 *
 * Phase 4 (commerce & enrollment design §8) adds `cart:manage`, `order:*`, `enrollment:*`,
 * `refund:review:any`, `platform_coupon:manage` and `sales:read:own`. Course pricing and
 * coupons reuse `course:read:own` / `course:update:own` through the course policy.
 * `enrollment:create` is the free enrolment (D14).
 *
 * Phase 5 (learning experience design §8) adds `notification:manage:own` (BASELINE, every app),
 * the learner permissions (`learning:participate`, `note:*`, `quiz_attempt:*`, `certificate:read`,
 * `review:write`, `wishlist:manage`), `qa:participate` and `content:report` (granted to BOTH
 * STUDENT and INSTRUCTOR: the same Q&A routes serve both BFFs and the use case admits ACTIVE
 * learners or the course owner), `course:engage:own` (review replies, announcements, the Q&A
 * inbox; nested routes go through the existing `course` resolver) and the admin
 * `content:moderate:any` / `certificate:manage:any`.
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
  // INSTRUCTOR (Phase 2)
  'course:create',
  'course:read:own',
  'course:update:own',
  'course:delete:own',
  'course:submit:own',
  'course:archive:own',
  'media_asset:create',
  'media_asset:read:own',
  'media_asset:upload:own',
  // ADMIN (Phase 2)
  'course:read:any',
  'course:moderate:any',
  'category:manage',
  'media_asset:read:any',
  // STUDENT (Phase 4)
  'cart:manage',
  'order:create',
  'order:read:own',
  'order:refund:own',
  'enrollment:create',
  'enrollment:read:own',
  // INSTRUCTOR (Phase 4)
  'sales:read:own',
  // ADMIN (Phase 4)
  'order:read:any',
  'order:refund:any',
  'refund:review:any',
  'platform_coupon:manage',
  'enrollment:read:any',
  'enrollment:grant:any',
  // Baseline (Phase 5): the caller's own inbox, unread count, mark-read and preferences.
  'notification:manage:own',
  // STUDENT (Phase 5)
  'learning:participate',
  'note:manage:own',
  'quiz_attempt:create',
  'quiz_attempt:submit:own',
  'quiz_attempt:read:own',
  'certificate:read:own',
  'review:write:own',
  'wishlist:manage:own',
  // STUDENT and INSTRUCTOR (Phase 5)
  'qa:participate',
  'content:report',
  // INSTRUCTOR (Phase 5)
  'course:engage:own',
  // ADMIN (Phase 5)
  'content:moderate:any',
  'certificate:manage:any',
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
