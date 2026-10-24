import { randomBytes } from 'node:crypto';

/** Crockford base32 (no I, L, O, U): `certificates_public_code_ck` / contracts CERTIFICATE_CODE_PATTERN. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CERTIFICATE_CODE_LENGTH = 26;

/**
 * A public verification code (design D7): 26 random Crockford base32 characters (130 bits),
 * separate from the uuidv7 id, which leaks the issue time and has fewer random bits. Each
 * character takes the low 5 bits of one CSPRNG byte (256 is a multiple of 32: no bias).
 */
export function newCertificateCode(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(CERTIFICATE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CERTIFICATE_CODE_LENGTH; i++) {
    code += CROCKFORD[(bytes[i] ?? 0) & 31];
  }
  return code;
}
