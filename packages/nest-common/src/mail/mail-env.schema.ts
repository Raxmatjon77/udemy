import { z } from 'zod';
import { envPort } from '../config/env-helpers';

const ADDRESS = String.raw`[^\s@<>]+@[^\s@<>]+`;
/** `no-reply@udemy.local` or `Udemy Clone <no-reply@udemy.local>`. */
export const MAIL_FROM_FORMAT = new RegExp(String.raw`^(?:${ADDRESS}|[^<>]*<${ADDRESS}>)$`);

/**
 * Env variables of `MailModule`. Spread into an app schema:
 * `baseEnvSchema.extend({ ...mailEnvShape, ... })`.
 */
export const mailEnvShape = {
  SMTP_HOST: z.string().min(1),
  /** 465 = implicit TLS; any other port uses plain SMTP with opportunistic STARTTLS. */
  SMTP_PORT: envPort,
  MAIL_FROM: z
    .string()
    .trim()
    .regex(MAIL_FROM_FORMAT, 'Expected "address@host" or "Display Name <address@host>"'),
};

export const mailEnvSchema = z.object(mailEnvShape);
export type MailEnv = z.output<typeof mailEnvSchema>;
