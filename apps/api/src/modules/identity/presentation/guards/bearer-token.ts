import type { Request } from 'express';

/** RFC 6750 b64token. */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

export type BearerToken =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'present'; readonly token: string };

/** Reads `Authorization: Bearer <token>`; anything else in the header is `malformed`. */
export function readBearerToken(req: Request): BearerToken {
  const header = req.headers.authorization;
  if (header === undefined || header === '') return { kind: 'absent' };
  const match = BEARER.exec(header);
  return match?.[1] === undefined ? { kind: 'malformed' } : { kind: 'present', token: match[1] };
}
