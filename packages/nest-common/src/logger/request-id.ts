import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Only accept short, log-safe ids from clients (blocks log injection / huge headers). */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first !== undefined && SAFE_ID.test(first) ? first : undefined;
}

/**
 * Request id = id of this single HTTP request. Reuses the inbound `x-request-id`
 * (set by an ingress / gateway) or generates a UUID, and echoes it in the response.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const id = readHeader(req, REQUEST_ID_HEADER) ?? randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * Correlation id = id of the whole business flow, which may span several requests and
 * services. Taken from `x-correlation-id` when the caller sends one, else the request id.
 */
export function resolveCorrelationId(req: IncomingMessage, requestId: string): string {
  return readHeader(req, CORRELATION_ID_HEADER) ?? requestId;
}
