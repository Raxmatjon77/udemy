import type { ClientContext } from '../../../shared/auth';
import type { SecurityEvent } from './ports/security-event.log';

/** The request-origin columns of a security event, from the authenticated BFF's context. */
export function clientFields(
  client: ClientContext,
): Pick<SecurityEvent, 'clientApp' | 'ip' | 'userAgent'> {
  return {
    clientApp: client.app,
    ip: client.ip,
    userAgent: client.userAgent === '' ? null : client.userAgent,
  };
}
