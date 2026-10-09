import { z } from 'zod';
import { ClientAppSchema } from '../auth/client-app';
import { RoleSchema } from '../auth/role';
import {
  CurrentPasswordSchema,
  DisplayNameSchema,
  EmailSchema,
  IsoDateTimeSchema,
  NewPasswordSchema,
  OpaqueTokenSchema,
  UuidSchema,
} from './fields';

/* ----------------------------------------------------------------------------------------
 * Shared
 * -------------------------------------------------------------------------------------- */

/** Body of every 202 that only acknowledges a request (signup, forgot password, ...). */
export const AcceptedResponseSchema = z.object({ status: z.literal('accepted') });
export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;

/** The user part of an AuthResult. */
export const AuthUserSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  /** All roles held, always including STUDENT. */
  roles: z.array(RoleSchema),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /auth/signup -> 202 AcceptedResponse
 * -------------------------------------------------------------------------------------- */

export const SignupRequestSchema = z.object({
  email: EmailSchema,
  password: NewPasswordSchema,
  displayName: DisplayNameSchema,
});
export type SignupRequest = z.output<typeof SignupRequestSchema>;

/** Same body for new and existing emails (no account enumeration). */
export const SignupResponseSchema = AcceptedResponseSchema;
export type SignupResponse = AcceptedResponse;

/* ----------------------------------------------------------------------------------------
 * POST /auth/login -> 200 AuthResult
 * -------------------------------------------------------------------------------------- */

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: CurrentPasswordSchema,
});
export type LoginRequest = z.output<typeof LoginRequestSchema>;

/** Login result. The refresh token is in the body for the BFF only; never forward it to a browser. */
export const AuthResultSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: IsoDateTimeSchema,
  refreshToken: z.string(),
  refreshTokenExpiresAt: IsoDateTimeSchema,
  sessionId: UuidSchema,
  user: AuthUserSchema,
});
export type AuthResult = z.infer<typeof AuthResultSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /auth/refresh -> 200 RefreshResult
 * POST /auth/logout  -> 204 (always)
 * POST /auth/logout-all -> 204
 * -------------------------------------------------------------------------------------- */

export const RefreshRequestSchema = z.object({ refreshToken: OpaqueTokenSchema });
export type RefreshRequest = z.output<typeof RefreshRequestSchema>;

/**
 * `refreshToken`/`refreshTokenExpiresAt` are absent on the reuse-grace path (a parallel
 * refresh already rotated the token): the BFF then keeps its current refresh cookie.
 */
export const RefreshResultSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: IsoDateTimeSchema,
  refreshToken: z.string().optional(),
  refreshTokenExpiresAt: IsoDateTimeSchema.optional(),
});
export type RefreshResult = z.infer<typeof RefreshResultSchema>;

export const LogoutRequestSchema = z.object({ refreshToken: OpaqueTokenSchema });
export type LogoutRequest = z.output<typeof LogoutRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /auth/sessions -> 200 SessionList
 * DELETE /auth/sessions/:sessionId -> 204
 * -------------------------------------------------------------------------------------- */

export const SessionViewSchema = z.object({
  id: UuidSchema,
  app: ClientAppSchema,
  /** Human-readable device parsed from the user agent at read time; null when unknown. */
  device: z.string().nullable(),
  /** Last known client IP. */
  ip: z.union([z.ipv4(), z.ipv6()]),
  createdAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema,
  /** True for the session that made this request. */
  current: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const SessionListResponseSchema = z.object({ items: z.array(SessionViewSchema) });
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const SessionIdParamsSchema = z.object({ sessionId: UuidSchema });
export type SessionIdParams = z.output<typeof SessionIdParamsSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /auth/email/verification-requests -> 202
 * POST /auth/email/verify -> 204
 * -------------------------------------------------------------------------------------- */

export const VerifyEmailRequestSchema = z.object({ token: OpaqueTokenSchema });
export type VerifyEmailRequest = z.output<typeof VerifyEmailRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /auth/password/forgot -> 202 (always)
 * POST /auth/password/reset  -> 204
 * POST /auth/password/change -> 204
 * -------------------------------------------------------------------------------------- */

export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema });
export type ForgotPasswordRequest = z.output<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: OpaqueTokenSchema,
  newPassword: NewPasswordSchema,
});
export type ResetPasswordRequest = z.output<typeof ResetPasswordRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: CurrentPasswordSchema,
  newPassword: NewPasswordSchema,
});
export type ChangePasswordRequest = z.output<typeof ChangePasswordRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /.well-known/jwks.json -> 200 Jwks
 * -------------------------------------------------------------------------------------- */

/** Public Ed25519 signing key (RFC 8037 OKP JWK). */
export const Ed25519JwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  /** base64url public key (32 bytes -> 43 chars). */
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** Key id, e.g. `ed25519-2026-10`. */
  kid: z.string().min(1),
  use: z.literal('sig'),
  alg: z.literal('EdDSA'),
});
export type Ed25519Jwk = z.infer<typeof Ed25519JwkSchema>;

export const JwksResponseSchema = z.object({ keys: z.array(Ed25519JwkSchema) });
export type JwksResponse = z.infer<typeof JwksResponseSchema>;
