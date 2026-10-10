import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
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
import {
  VerifiesWebhookSignature,
  WebhookEndpoint,
  WebhookIngress,
} from './webhook-ingress.decorators';

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
      ingress: { kind: 'default' },
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
      ingress: { kind: 'default' },
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
      ingress: { kind: 'default' },
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

@VerifiesWebhookSignature('stripe')
class StripeGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

class PlainGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

class WebhookRoutes {
  @WebhookEndpoint('stripe', StripeGuard)
  @Post('composite')
  composite(): void {}

  @Public()
  @NoClientAuth()
  @WebhookIngress('stripe')
  @UseGuards(PlainGuard, new StripeGuard())
  @Post('instance')
  guardInstance(): void {}

  @Public()
  @NoClientAuth()
  @WebhookIngress('stripe')
  @Post('unguarded')
  unguarded(): void {}

  @Public()
  @NoClientAuth()
  @WebhookIngress('stripe')
  @UseGuards(PlainGuard)
  @Post('plain')
  plainGuard(): void {}

  @RequirePermissions('user:read:any')
  @WebhookIngress('stripe')
  @UseGuards(StripeGuard)
  @Post('user')
  withUser(): void {}

  @Public()
  @WebhookIngress('stripe')
  @UseGuards(StripeGuard)
  @Post('client')
  withClient(): void {}

  @Public()
  @NoClientAuth()
  @WebhookIngress('stripe')
  @UseGuards(StripeGuard)
  @Get('get')
  viaGet(): void {}

  @Public()
  @NoClientAuth()
  @Put('write')
  unauthenticatedWrite(): void {}

  @Public()
  @NoClientAuth()
  @Get('read')
  unauthenticatedRead(): void {}
}

@Public()
@NoClientAuth()
@WebhookIngress('stripe')
@UseGuards(StripeGuard)
@Controller('hooks')
class ControllerLevelWebhook {
  @Post()
  receive(): void {}
}

describe('describeRoute: @WebhookIngress', () => {
  it('accepts the WebhookEndpoint composite (public, no client, POST, signature guard)', () => {
    expect(describeOn(WebhookRoutes, 'composite')).toEqual({
      security: { kind: 'public', level: 'handler' },
      client: { kind: 'none', level: 'handler' },
      ingress: {
        kind: 'webhook',
        level: 'handler',
        provider: 'stripe',
        signatureGuards: ['StripeGuard'],
      },
      problems: [],
    });
  });

  it('accepts a guard instance and markers on the controller', () => {
    expect(describeOn(WebhookRoutes, 'guardInstance').problems).toEqual([]);
    expect(describeOn(ControllerLevelWebhook, 'receive')).toMatchObject({
      ingress: { kind: 'webhook', level: 'controller', signatureGuards: ['StripeGuard'] },
      problems: [],
    });
  });

  it.each(['unguarded', 'plainGuard'])('requires a signature-verifying guard (%s)', (method) => {
    expect(describeOn(WebhookRoutes, method).problems).toEqual([
      expect.stringContaining("@WebhookIngress('stripe') without a signature guard"),
    ]);
  });

  it.each(['withUser', 'withClient'])('requires @Public and @NoClientAuth (%s)', (method) => {
    expect(describeOn(WebhookRoutes, method).problems).toContainEqual(
      expect.stringContaining('needs @Public and @NoClientAuth'),
    );
  });

  it('requires POST', () => {
    expect(describeOn(WebhookRoutes, 'viaGet').problems).toEqual([
      expect.stringContaining('on a GET route: webhooks must be POST'),
    ]);
  });

  it('flags @NoClientAuth on an unsafe method without @WebhookIngress, not on a read', () => {
    expect(describeOn(WebhookRoutes, 'unauthenticatedWrite').problems).toEqual([
      expect.stringContaining('@NoClientAuth on a PUT route'),
    ]);
    expect(describeOn(WebhookRoutes, 'unauthenticatedRead').problems).toEqual([]);
  });

  it('rejects misuse at decoration time', () => {
    expect(() => WebhookEndpoint('stripe', PlainGuard)).toThrow(TypeError);
    const bogus = 'paypal' as Parameters<typeof WebhookIngress>[0];
    expect(() => WebhookIngress(bogus)).toThrow(TypeError);
    expect(() => VerifiesWebhookSignature(bogus)).toThrow(TypeError);
    class NotAGuard {}
    expect(() =>
      VerifiesWebhookSignature('stripe')(NotAGuard as unknown as new () => CanActivate),
    ).toThrow(TypeError);
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
