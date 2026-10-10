import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The media type of `content-type`, lower-cased, without parameters. */
export function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: OutgoingHttpHeaders,
): void {
  const buffer = Buffer.from(body, 'utf8');
  res.writeHead(status, { ...headers, 'content-length': buffer.length });
  res.end(buffer);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  send(res, status, `${JSON.stringify(value, null, 2)}\n`, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    ...headers,
  });
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}
