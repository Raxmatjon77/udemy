import type { ClientApp } from '@udemy/contracts';
import type { Request } from 'express';

export const CLIENT_ID_HEADER = 'x-client-id';
export const CLIENT_SECRET_HEADER = 'x-client-secret';

/** `X-Client-Id` of each BFF (design §9 "Client authentication and IP trust"). */
export const CLIENT_IDS = {
  'student-bff': 'student',
  'instructor-bff': 'instructor',
  'admin-bff': 'admin',
} as const satisfies Record<string, ClientApp>;

export type ClientId = keyof typeof CLIENT_IDS;

export function isClientId(value: string): value is ClientId {
  return Object.hasOwn(CLIENT_IDS, value);
}

/** A header sent exactly once; repeated headers (joined or arrays) are not credentials. */
export function singleHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
