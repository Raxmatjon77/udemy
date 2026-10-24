import { type CanActivate, Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { DiscoveryModule, MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  AuthenticatedOnly,
  AuthMetadataReader,
  CheckPolicy,
  NoClientAuth,
  type OwnershipResolver,
  OwnershipResolverFor,
  Public,
  RequirePermissions,
  VerifiesWebhookSignature,
  WebhookEndpoint,
  WebhookIngress,
} from '../../../shared/auth';
import { HealthController } from '../../../shared/health/health.controller';
import { RealtimeGateway } from '../../../shared/realtime';
import { OwnershipRegistry } from '../application/ownership.registry';
import { RouteSecurityAuditor, RouteSecurityError } from './route-security.auditor';

const byId = (req: Request): string => req.params.id as string;

@Controller('good')
class GoodController {
  @Public()
  @Get('open')
  open(): void {}

  @AuthenticatedOnly()
  @Get('me')
  me(): void {}

  @RequirePermissions('user:read:any')
  @Get('users')
  users(): void {}

  /** Not a route: never audited. */
  helper(): void {}
}

@AuthenticatedOnly()
@Controller('inherited')
class ControllerLevelController {
  @Get()
  list(): void {}
}

@Controller('bad')
class BadController {
  @Get('unmarked')
  unmarked(): void {}

  @Public()
  @RequirePermissions('user:read:any')
  @Post('conflict')
  conflict(): void {}

  @AuthenticatedOnly()
  @NoClientAuth()
  @Get('misused')
  misused(): void {}

  @Public()
  @Get('fine')
  fine(): void {}
}

@Controller('applications')
class PolicyController {
  @CheckPolicy({ resource: 'instructor_application', action: 'read', id: byId })
  @Get(':id')
  get(): void {}
}

@VerifiesWebhookSignature('stripe')
class FakeStripeSignatureGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Controller('webhooks')
class GoodWebhookController {
  @WebhookEndpoint('stripe', FakeStripeSignatureGuard)
  @Post('stripe')
  stripe(): void {}

  @Public()
  @NoClientAuth()
  @Get('status')
  status(): void {}
}

@Controller('webhooks')
class UnsignedWebhookController {
  @Public()
  @NoClientAuth()
  @WebhookIngress('stripe')
  @UseGuards()
  @Post('stripe')
  stripe(): void {}

  @Public()
  @NoClientAuth()
  @Post('open-write')
  openWrite(): void {}
}

@OwnershipResolverFor('instructor_application')
class ApplicationOwnership implements OwnershipResolver {
  async ownerOf(): Promise<string | null> {
    return null;
  }
}

@Module({ providers: [ApplicationOwnership] })
class OwnershipModule {}

@RealtimeGateway()
class GoodGateway {
  @SubscribeMessage('subscribe')
  @AuthenticatedOnly()
  subscribe(): void {}

  @SubscribeMessage('admin')
  @RequirePermissions('user:read:any')
  admin(): void {}

  /** Not a message handler: never audited. */
  handleConnection(): void {}
}

@RealtimeGateway()
class BadGateway {
  @SubscribeMessage('unmarked')
  unmarked(): void {}

  @SubscribeMessage('policy')
  @CheckPolicy({ resource: 'instructor_application', action: 'read', id: byId })
  policy(): void {}

  @SubscribeMessage('open')
  @Public()
  @NoClientAuth()
  open(): void {}

  @SubscribeMessage('fine')
  @AuthenticatedOnly()
  fine(): void {}
}

@WebSocketGateway()
class PlainGateway {
  @SubscribeMessage('ping')
  @AuthenticatedOnly()
  ping(): void {}
}

/** A provider that is not a gateway: its handler would never be bound, or bound unguarded. */
class StrayHandlers {
  @SubscribeMessage('stray')
  @AuthenticatedOnly()
  stray(): void {}
}

async function boot(
  controllers: (new () => unknown)[],
  imports: (new () => unknown)[] = [],
  providers: (new () => unknown)[] = [],
): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule, ...imports],
    controllers,
    providers: [AuthMetadataReader, OwnershipRegistry, RouteSecurityAuditor, ...providers],
  }).compile();
  await moduleRef.init();
  await moduleRef.close();
}

describe('RouteSecurityAuditor', () => {
  it('boots when every route is marked', async () => {
    await expect(boot([GoodController, ControllerLevelController])).resolves.toBeUndefined();
  });

  it('fails boot and lists every misconfigured Controller.method', async () => {
    const error = await boot([GoodController, BadController]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouteSecurityError);
    const findings = (error as RouteSecurityError).findings;
    expect(findings.map((f) => f.route)).toEqual([
      'BadController.unmarked',
      'BadController.conflict',
      'BadController.misused',
    ]);
    expect((error as Error).message).toMatch(/BadController\.unmarked: no security marker/);
    expect((error as Error).message).toMatch(/BadController\.conflict: conflicting markers/);
    expect((error as Error).message).toMatch(/BadController\.misused: @NoClientAuth/);
  });

  it('fails boot when a @CheckPolicy resource has no ownership resolver', async () => {
    await expect(boot([PolicyController])).rejects.toThrow(
      /PolicyController\.get: @CheckPolicy on 'instructor_application' needs an @OwnershipResolverFor/,
    );
    await expect(boot([PolicyController], [OwnershipModule])).resolves.toBeUndefined();
  });

  it('accepts a webhook only with a signature guard; fails boot otherwise', async () => {
    await expect(boot([GoodWebhookController])).resolves.toBeUndefined();

    const error = await boot([UnsignedWebhookController]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouteSecurityError);
    expect((error as RouteSecurityError).findings).toEqual([
      {
        route: 'UnsignedWebhookController.stripe',
        problems: [expect.stringContaining("@WebhookIngress('stripe') without a signature guard")],
      },
      {
        route: 'UnsignedWebhookController.openWrite',
        problems: [expect.stringContaining('@NoClientAuth on a POST route')],
      },
    ]);
  });

  it('inventories every route without client authentication', () => {
    const auditor = new RouteSecurityAuditor(
      {
        getControllers: () => [
          { metatype: GoodWebhookController },
          { metatype: GoodController },
          { metatype: HealthController },
        ],
        getProviders: () => [],
      } as never,
      new MetadataScanner(),
      new AuthMetadataReader(),
      { has: () => true } as never,
    );

    expect(auditor.nonBffRoutes()).toEqual([
      { route: 'HealthController.live', method: 'GET', path: '/health/live', ingress: 'read' },
      { route: 'HealthController.ready', method: 'GET', path: '/health/ready', ingress: 'read' },
      {
        route: 'GoodWebhookController.status',
        method: 'GET',
        path: '/webhooks/status',
        ingress: 'read',
      },
      {
        route: 'GoodWebhookController.stripe',
        method: 'POST',
        path: '/webhooks/stripe',
        ingress: 'webhook:stripe',
      },
    ]);
  });

  it('accepts the real HealthController (@Public @NoClientAuth)', () => {
    const auditor = new RouteSecurityAuditor(
      { getControllers: () => [{ metatype: HealthController }], getProviders: () => [] } as never,
      new MetadataScanner(),
      new AuthMetadataReader(),
      { has: () => true } as never,
    );
    expect(auditor.audit()).toEqual([]);
  });

  describe('socket.io gateways (Phase 5 design §9)', () => {
    function auditorFor(providers: (new () => unknown)[]): RouteSecurityAuditor {
      return new RouteSecurityAuditor(
        {
          getControllers: () => [],
          getProviders: () => providers.map((metatype) => ({ metatype })),
        } as never,
        new MetadataScanner(),
        new AuthMetadataReader(),
        { has: () => true } as never,
      );
    }

    it('boots when every handler of a @RealtimeGateway is marked', async () => {
      await expect(boot([GoodController], [], [GoodGateway])).resolves.toBeUndefined();
      expect(auditorFor([GoodGateway]).realtimeGateways()).toEqual(['GoodGateway']);
    });

    it('fails boot for unmarked, @CheckPolicy and @NoClientAuth gateway handlers', () => {
      expect(auditorFor([BadGateway]).audit()).toEqual([
        { route: 'BadGateway.unmarked', problems: [expect.stringContaining('no security marker')] },
        {
          route: 'BadGateway.policy',
          problems: [expect.stringContaining('@CheckPolicy on a socket handler')],
        },
        {
          route: 'BadGateway.open',
          problems: [expect.stringContaining('@NoClientAuth on a socket handler')],
        },
      ]);
    });

    it('fails boot for a plain @WebSocketGateway and a @SubscribeMessage outside a gateway', async () => {
      expect(auditorFor([PlainGateway, StrayHandlers]).audit()).toEqual([
        {
          route: 'PlainGateway',
          problems: [expect.stringContaining('@WebSocketGateway without @RealtimeGateway')],
        },
        {
          route: 'StrayHandlers.stray',
          problems: ['@SubscribeMessage outside a @RealtimeGateway class'],
        },
      ]);
      const error = await boot([], [], [StrayHandlers]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RouteSecurityError);
    });
  });
});
