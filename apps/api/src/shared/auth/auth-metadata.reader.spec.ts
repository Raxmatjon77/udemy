import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthMetadataReader, describeRoute } from './auth-metadata.reader';
import {
  AllowClients,
  AuthenticatedOnly,
  CheckPolicy,
  NoClientAuth,
  Public,
  RequirePermissions,
} from './auth.decorators';

const byId = (): string => 'id';

@RequirePermissions('user:read:any')
@AllowClients('admin')
class AdminController {
  inherits(): void {}

  @Public()
  publicOverride(): void {}

  @CheckPolicy({ resource: 'user', action: 'ban', id: byId })
  policyOverride(): void {}

  @AllowClients('instructor')
  clientOverride(): void {}
}

class BareController {
  unmarked(): void {}

  @Public()
  @RequirePermissions('user:read:any')
  publicAndPermission(): void {}

  @AuthenticatedOnly()
  @Public()
  twoStandalone(): void {}

  @RequirePermissions('user:ban:any')
  @CheckPolicy({ resource: 'instructor_application', action: 'review', id: byId })
  permissionAndPolicy(): void {}

  @Public()
  @NoClientAuth()
  probe(): void {}

  @AuthenticatedOnly()
  @NoClientAuth()
  userWithoutClient(): void {}

  @Public()
  @NoClientAuth()
  @AllowClients('student')
  clientConflict(): void {}
}

const describeOn = (controller: { prototype: object }, method: string) =>
  describeRoute(Reflect.get(controller.prototype, method) as object, controller);

describe('describeRoute', () => {
  it('reports a route without any marker as missing (startup must fail)', () => {
    expect(describeOn(BareController, 'unmarked')).toEqual({
      security: { kind: 'missing' },
      client: { kind: 'any' },
      problems: [expect.stringContaining('no security marker')],
    });
  });

  it('uses the controller markers when the handler has none', () => {
    expect(describeOn(AdminController, 'inherits')).toEqual({
      security: {
        kind: 'authorized',
        level: 'controller',
        permissions: ['user:read:any'],
        policies: [],
      },
      client: { kind: 'restricted', level: 'controller', apps: ['admin'] },
      problems: [],
    });
  });

  it('lets handler markers replace the controller markers', () => {
    expect(describeOn(AdminController, 'publicOverride').security).toEqual({
      kind: 'public',
      level: 'handler',
    });
    expect(describeOn(AdminController, 'policyOverride').security).toMatchObject({
      kind: 'authorized',
      level: 'handler',
      permissions: [],
      policies: [{ resource: 'user', action: 'ban' }],
    });
    expect(describeOn(AdminController, 'clientOverride').client).toEqual({
      kind: 'restricted',
      level: 'handler',
      apps: ['instructor'],
    });
  });

  it('combines @RequirePermissions and @CheckPolicy on one level', () => {
    expect(describeOn(BareController, 'permissionAndPolicy')).toMatchObject({
      security: {
        kind: 'authorized',
        permissions: ['user:ban:any'],
        policies: [{ resource: 'instructor_application', action: 'review' }],
      },
      problems: [],
    });
  });

  it.each(['publicAndPermission', 'twoStandalone'])(
    'flags standalone markers mixed with others (%s)',
    (method) => {
      const route = describeOn(BareController, method);
      expect(route.security.kind).toBe('conflict');
      expect(route.problems).toEqual([
        expect.stringContaining('conflicting markers on the handler'),
      ]);
    },
  );

  it('accepts @NoClientAuth on a public route', () => {
    expect(describeOn(BareController, 'probe')).toEqual({
      security: { kind: 'public', level: 'handler' },
      client: { kind: 'none', level: 'handler' },
      problems: [],
    });
  });

  it('flags @NoClientAuth on a route that needs a user', () => {
    expect(describeOn(BareController, 'userWithoutClient').problems).toEqual([
      expect.stringContaining('access tokens are bound to a client app'),
    ]);
  });

  it('flags @NoClientAuth together with @AllowClients', () => {
    const route = describeOn(BareController, 'clientConflict');
    expect(route.client).toEqual({ kind: 'conflict', level: 'handler' });
    expect(route.problems).toEqual([expect.stringContaining('@NoClientAuth and @AllowClients')]);
  });
});

describe('AuthMetadataReader', () => {
  it('describes the route of an ExecutionContext and caches the result', () => {
    const reader = new AuthMetadataReader();
    const ctx = {
      getHandler: () => AdminController.prototype.inherits,
      getClass: () => AdminController,
    } as unknown as ExecutionContext;

    const first = reader.forContext(ctx);

    expect(first.security.kind).toBe('authorized');
    expect(reader.forContext(ctx)).toBe(first);
  });

  it('keeps the cache per controller (an inherited handler can have different class markers)', () => {
    class OpenController {
      @AuthenticatedOnly()
      shared(): void {}
    }
    @Public()
    class Other extends OpenController {}
    const reader = new AuthMetadataReader();
    const handler = OpenController.prototype.shared;

    expect(reader.describe(handler, OpenController).security.kind).toBe('authenticated');
    expect(reader.describe(handler, Other).security.kind).toBe('authenticated');
    expect(reader.describe(Other.prototype.shared, Other)).toBe(reader.describe(handler, Other));
  });
});
