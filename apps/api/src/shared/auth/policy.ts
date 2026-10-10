import type { Permission } from '@udemy/contracts';
import type { Request } from 'express';

type Scope = 'own' | 'any';
type ScopedPermission = Extract<Permission, `${string}:${string}:${Scope}`>;

type ResourceOf<P> = P extends `${infer R}:${string}:${Scope}` ? R : never;
type ActionOf<P, R extends string> = P extends `${R}:${infer A}:${Scope}` ? A : never;

/** Resource types that have scoped (`:own` / `:any`) permissions, e.g. `instructor_application`. */
export type PolicyResource = ResourceOf<ScopedPermission>;

/** Actions on a resource that have scoped permissions, e.g. `read` | `withdraw` for applications. */
export type PolicyAction<R extends PolicyResource> = ActionOf<ScopedPermission, R>;

/** `@CheckPolicy` argument for one resource type. */
export interface PolicySpecFor<R extends PolicyResource> {
  readonly resource: R;
  readonly action: PolicyAction<R>;
  /** Extracts the resource id from the request, e.g. `(req) => req.params.id`. */
  readonly id: (req: Request) => string;
}

/** Any policy spec (union over all resource types). */
export type PolicySpec = { [R in PolicyResource]: PolicySpecFor<R> }[PolicyResource];
