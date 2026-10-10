import { isIP } from 'node:net';

/**
 * `inet` columns accept only literal addresses (anything else raises 22P02 and would abort the
 * transaction). ClientIpResolver can yield `unknown` when no address is determinable.
 */
export function toInetOrNull(ip: string | null | undefined): string | null {
  return ip !== null && ip !== undefined && isIP(ip) !== 0 ? ip : null;
}

/** For NOT NULL inet columns (sessions.created_ip/last_ip): the unspecified address. */
export const UNSPECIFIED_IP = '0.0.0.0';

export function toInet(ip: string): string {
  return toInetOrNull(ip) ?? UNSPECIFIED_IP;
}
