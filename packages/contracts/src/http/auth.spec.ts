import { describe, expect, it } from 'vitest';
import {
  AuthResultSchema,
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  JwksResponseSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  RefreshResultSchema,
  ResetPasswordRequestSchema,
  SessionIdParamsSchema,
  SessionListResponseSchema,
  SignupRequestSchema,
  SignupResponseSchema,
  VerifyEmailRequestSchema,
} from './auth';

const id = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c01';
const at = '2026-10-10T12:00:00.000Z';
const signup = { email: 'jane@example.com', password: 'correct horse', displayName: 'Jane' };

describe('SignupRequestSchema', () => {
  it('accepts a valid body and normalises email and display name', () => {
    expect(
      SignupRequestSchema.parse({ ...signup, email: '  Jane@Example.COM ', displayName: ' Jane ' }),
    ).toEqual(signup);
  });

  it('applies the email rules', () => {
    const local64 = `${'a'.repeat(64)}@example.com`;
    expect(SignupRequestSchema.safeParse({ ...signup, email: local64 }).success).toBe(true);
    for (const email of [
      `${'a'.repeat(65)}@example.com`,
      `${'a'.repeat(60)}@${'b'.repeat(190)}.com`, // 255 chars
      'not-an-email',
      'jane@localhost',
      '',
    ]) {
      expect(SignupRequestSchema.safeParse({ ...signup, email }).success, email).toBe(false);
    }
  });

  it('applies the password length 10–128 without trimming', () => {
    const ok = (password: string) => SignupRequestSchema.safeParse({ ...signup, password }).success;
    expect(ok('a'.repeat(10))).toBe(true);
    expect(ok('a'.repeat(128))).toBe(true);
    expect(ok('a'.repeat(9))).toBe(false);
    expect(ok('a'.repeat(129))).toBe(false);
    expect(SignupRequestSchema.parse({ ...signup, password: ' spaced pw ' }).password).toBe(
      ' spaced pw ',
    );
  });

  it('applies the display name rules', () => {
    const ok = (displayName: string) =>
      SignupRequestSchema.safeParse({ ...signup, displayName }).success;
    expect(ok('a'.repeat(60))).toBe(true);
    expect(ok('a'.repeat(61))).toBe(false);
    expect(ok('   ')).toBe(false);
    expect(ok('Jane\u0000Doe')).toBe(false);
    expect(ok('Jane\nDoe')).toBe(false);
  });
});

describe('LoginRequestSchema', () => {
  it('accepts a short legacy password but bounds it at 128', () => {
    expect(LoginRequestSchema.safeParse({ email: 'jane@example.com', password: 'x' }).success).toBe(
      true,
    );
    expect(
      LoginRequestSchema.safeParse({ email: 'jane@example.com', password: 'x'.repeat(129) })
        .success,
    ).toBe(false);
    expect(LoginRequestSchema.safeParse({ email: 'jane@example.com', password: '' }).success).toBe(
      false,
    );
  });
});

describe('token request bodies', () => {
  it.each([
    ['refresh', RefreshRequestSchema, 'refreshToken'],
    ['logout', LogoutRequestSchema, 'refreshToken'],
    ['verify email', VerifyEmailRequestSchema, 'token'],
  ] as const)('%s accepts a token and rejects empty/oversized', (_name, schema, key) => {
    expect(schema.safeParse({ [key]: 'a'.repeat(43) }).success).toBe(true);
    expect(schema.safeParse({ [key]: '' }).success).toBe(false);
    expect(schema.safeParse({ [key]: 'a'.repeat(513) }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});

describe('password flows', () => {
  it('forgot password normalises the email', () => {
    expect(ForgotPasswordRequestSchema.parse({ email: ' A@B.io ' })).toEqual({ email: 'a@b.io' });
    expect(ForgotPasswordRequestSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });

  it('reset password requires a token and a policy-length password', () => {
    expect(
      ResetPasswordRequestSchema.safeParse({ token: 't', newPassword: 'long enough!' }).success,
    ).toBe(true);
    expect(ResetPasswordRequestSchema.safeParse({ token: 't', newPassword: 'short' }).success).toBe(
      false,
    );
    expect(
      ResetPasswordRequestSchema.safeParse({ token: '', newPassword: 'long enough!' }).success,
    ).toBe(false);
  });

  it('change password', () => {
    const body = { currentPassword: 'old', newPassword: 'a brand new one' };
    expect(ChangePasswordRequestSchema.safeParse(body).success).toBe(true);
    expect(
      ChangePasswordRequestSchema.safeParse({ ...body, newPassword: 'x'.repeat(129) }).success,
    ).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ ...body, currentPassword: '' }).success).toBe(
      false,
    );
  });
});

describe('params', () => {
  it('requires a uuid session id', () => {
    expect(SessionIdParamsSchema.safeParse({ sessionId: id }).success).toBe(true);
    expect(SessionIdParamsSchema.safeParse({ sessionId: '42' }).success).toBe(false);
  });
});

describe('response schemas', () => {
  it('accept valid examples', () => {
    expect(SignupResponseSchema.safeParse({ status: 'accepted' }).success).toBe(true);
    const auth = {
      accessToken: 'eyJ...',
      accessTokenExpiresAt: at,
      refreshToken: 'rt',
      refreshTokenExpiresAt: at,
      sessionId: id,
      user: {
        id,
        email: 'jane@example.com',
        displayName: 'Jane',
        emailVerified: false,
        roles: ['STUDENT'],
      },
    };
    expect(AuthResultSchema.parse(auth)).toEqual(auth);
    expect(
      RefreshResultSchema.safeParse({ accessToken: 'a', accessTokenExpiresAt: at }).success,
    ).toBe(true);
    expect(
      SessionListResponseSchema.safeParse({
        items: [
          {
            id,
            app: 'student',
            device: null,
            ip: '::1',
            createdAt: at,
            lastUsedAt: at,
            current: true,
          },
          {
            id,
            app: 'admin',
            device: 'Firefox on Linux',
            ip: '10.0.0.1',
            createdAt: at,
            lastUsedAt: at,
            current: false,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      JwksResponseSchema.safeParse({
        keys: [
          {
            kty: 'OKP',
            crv: 'Ed25519',
            x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
            kid: 'ed25519-2026-10',
            use: 'sig',
            alg: 'EdDSA',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('reject invalid examples', () => {
    expect(SignupResponseSchema.safeParse({ accepted: true }).success).toBe(false);
    expect(
      JwksResponseSchema.safeParse({
        keys: [{ kty: 'RSA', crv: 'Ed25519', x: 'x', kid: 'k', use: 'sig', alg: 'RS256' }],
      }).success,
    ).toBe(false);
  });
});
