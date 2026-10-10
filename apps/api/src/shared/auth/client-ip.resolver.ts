import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isClientAuthenticated } from './auth-request';

/** End-user IP as seen by the BFF (design §9, "Client authentication and IP trust"). */
export const CLIENT_IP_HEADER = 'x-client-ip';
/** End-user User-Agent as seen by the BFF. */
export const CLIENT_USER_AGENT_HEADER = 'x-client-user-agent';
/** Used when no address can be determined; rate limits then share one (strict) bucket. */
export const UNKNOWN_IP = 'unknown';

const MAX_USER_AGENT_LENGTH = 512;

function singleHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A canonical IP string, or undefined. Rejects lists (`a, b`: duplicate headers are joined
 * with commas), ports and anything else that is not a single literal address. IPv4-mapped
 * IPv6 (`::ffff:1.2.3.4`) becomes plain IPv4, so one user never gets two rate-limit keys.
 */
export function normalizeIp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (isIP(value) === 0) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return mapped?.[1] ?? value;
}

/**
 * Determines the end-user IP for rate limiting, sessions and security events.
 *
 * - Client-authenticated request (ClientAuthGuard ran `markClientAuthenticated`): the BFF's
 *   `X-Client-IP`, if it is a single valid address.
 * - Otherwise, or if the header is missing/invalid: Express' `req.ip`, which honours
 *   `trust proxy` (TRUST_PROXY_HOPS), then the socket address.
 *
 * An unauthenticated caller can therefore never choose its own rate-limit key.
 */
@Injectable()
export class ClientIpResolver {
  resolve(req: Request): string {
    if (isClientAuthenticated(req)) {
      const forwarded = normalizeIp(singleHeader(req, CLIENT_IP_HEADER));
      if (forwarded !== undefined) return forwarded;
    }
    return normalizeIp(req.ip) ?? normalizeIp(req.socket.remoteAddress) ?? UNKNOWN_IP;
  }

  /** Same trust rule for the User-Agent: X-Client-User-Agent only from an authenticated BFF. */
  resolveUserAgent(req: Request): string {
    const forwarded = isClientAuthenticated(req)
      ? singleHeader(req, CLIENT_USER_AGENT_HEADER)
      : undefined;
    const userAgent = forwarded ?? singleHeader(req, 'user-agent') ?? '';
    return userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  }
}
