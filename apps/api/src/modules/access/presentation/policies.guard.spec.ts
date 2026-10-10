import type { ExecutionContext } from '@nestjs/common';
import type { ClientApp, Role } from '@udemy/contracts';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@udemy/nest-common/errors';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticatedOnly,
  AuthMetadataReader,
  CheckPolicy,
  NoClientAuth,
  type Principal,
  Public,
  RequirePermissions,
  setPrincipal,
} from '../../../shared/auth';
import { Authorizer } from '../application/authorizer';
import type { OwnershipRegistry } from '../application/ownership.registry';
import { effectivePermissions } from '../domain/permission-policy';
import { PoliciesGuard } from './policies.guard';

const ALICE = '0199b0a4-0000-7000-8000-00000000000a';
const BOB = '0199b0a4-0000-7000-8000-00000000000b';
const APP_1 = '0199b0a4-0000-7000-8000-000000000101';

const byId = (req: Request): string => req.params.id as string;

class TestController {
  @Public()
  open(): void {}

  @AuthenticatedOnly()
  me(): void {}

  @RequirePermissions('user:read:any', 'user:ban:any')
  ban(): void {}

  @CheckPolicy({ resource: 'instructor_application', action: 'read', id: byId })
  application(): void {}

  @RequirePermissions('user:read:any')
  @CheckPolicy({ resource: 'instructor_application', action: 'read', id: byId })
  both(): void {}

  unmarked(): void {}

  @AuthenticatedOnly()
  @NoClientAuth()
  misused(): void {}
}

function principal(userId: string, roles: Role[], app: ClientApp): Principal {
  return {
    userId,
    sessionId: 's',
    app,
    roles,
    permissions: effectivePermissions(roles, app),
    tokenId: 't',
  };
}

function setup(owners: Record<string, string> = {}) {
  const ownerOf = vi.fn(async (id: string) => owners[id] ?? null);
  const registry = { get: () => ({ ownerOf }), has: () => true } as unknown as OwnershipRegistry;
  const guard = new PoliciesGuard(new AuthMetadataReader(), new Authorizer(registry));
  const run = (
    method: keyof TestController,
    who?: Principal,
    params: Record<string, string> = {},
  ): Promise<boolean> => {
    const req = { params } as unknown as Request;
    if (who !== undefined) setPrincipal(req, who);
    const ctx = {
      getType: () => 'http',
      getHandler: () => TestController.prototype[method],
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return guard.canActivate(ctx);
  };
  return { run, ownerOf };
}

const student = principal(ALICE, ['STUDENT'], 'student');
const admin = principal(ALICE, ['STUDENT', 'ADMIN'], 'admin');

describe('PoliciesGuard', () => {
  it('@Public allows without a principal', async () => {
    await expect(setup().run('open')).resolves.toBe(true);
  });

  it('@AuthenticatedOnly requires a principal (401 otherwise)', async () => {
    const { run } = setup();
    await expect(run('me', student)).resolves.toBe(true);
    await expect(run('me')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('@RequirePermissions needs every listed permission', async () => {
    const { run } = setup();
    await expect(run('ban', admin)).resolves.toBe(true);
    await expect(run('ban', student)).rejects.toBeInstanceOf(ForbiddenError);
    // ADMIN role, wrong app: the permissions are app-scoped (D6).
    await expect(run('ban', principal(ALICE, ['STUDENT', 'ADMIN'], 'student'))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(run('ban')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('@CheckPolicy: :any allows, owner allows, foreign/missing is 404, no permission is 403', async () => {
    const { run, ownerOf } = setup({ [APP_1]: ALICE });
    await expect(run('application', admin, { id: APP_1 })).resolves.toBe(true);
    expect(ownerOf).not.toHaveBeenCalled();

    await expect(run('application', student, { id: APP_1 })).resolves.toBe(true);
    await expect(
      run('application', principal(BOB, ['STUDENT'], 'student'), { id: APP_1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(run('application', student, { id: 'missing' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(run('application', student, {})).rejects.toBeInstanceOf(NotFoundError);

    const instructor = principal(ALICE, ['STUDENT', 'INSTRUCTOR'], 'instructor');
    await expect(run('application', instructor, { id: APP_1 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(run('application', undefined, { id: APP_1 })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('combined permissions + policy: both must pass', async () => {
    const { run } = setup({ [APP_1]: BOB });
    await expect(run('both', admin, { id: APP_1 })).resolves.toBe(true);
    await expect(run('both', student, { id: APP_1 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('fails closed (500) on misconfigured routes', async () => {
    const { run } = setup();
    await expect(run('unmarked', admin)).rejects.toThrow(/invalid security configuration/);
    await expect(run('misused', admin)).rejects.toThrow(/invalid security configuration/);
  });

  it('error codes are the contract codes', async () => {
    const { run } = setup({ [APP_1]: BOB });
    await expect(run('me')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(run('ban', student)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run('application', student, { id: APP_1 })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
