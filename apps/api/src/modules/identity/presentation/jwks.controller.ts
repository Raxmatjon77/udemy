import { Controller, Get, Header, RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { JwksResponse } from '@udemy/contracts';
import { NoClientAuth, Public } from '../../../shared/auth';
import { GetJwksQuery } from '../application/get-jwks.query';

export const JWKS_PATH = '.well-known/jwks.json';

/**
 * Routes of this module that live outside the global `api` prefix. Pass them to
 * `app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: IDENTITY_PREFIX_EXCLUSIONS })`.
 */
export const IDENTITY_PREFIX_EXCLUSIONS = [
  { path: JWKS_PATH, method: RequestMethod.GET },
] as const satisfies readonly { path: string; method: RequestMethod }[];

/**
 * `GET /.well-known/jwks.json` (design §8): the public keys the BFFs verify access tokens with.
 * Outside the `api` prefix and unversioned (well-known URI), no client or user auth. Cached for
 * 5 minutes; key rotation waits at least that long before activating a new key (design §9).
 */
@ApiTags('identity')
@Public()
@NoClientAuth() // fetched by the BFFs' JWKS cache and any future verifier, no credentials
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class JwksController {
  constructor(private readonly jwks: GetJwksQuery) {}

  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  get(): JwksResponse {
    return this.jwks.execute();
  }
}
