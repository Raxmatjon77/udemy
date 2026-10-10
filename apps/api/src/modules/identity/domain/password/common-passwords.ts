/*
 * The 10,000 most common passwords, lowercased, one JSON string each.
 *
 * Source: SecLists, Passwords/Common-Credentials/10k-most-common.txt
 *   https://github.com/danielmiessler/SecLists (MIT licence), list compiled by Mark Burnett.
 *   Downloaded 2026-10-10; SHA-256 of the original text file:
 *   68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce
 *
 * Shipped as JSON (not .txt) so `tsc` copies it into dist with the code that imports it,
 * without any nest-cli asset configuration. Most entries are shorter than the 10-character
 * minimum and are already refused by the length rule; the full list is kept so the source
 * stays verifiable and the policy stays correct if the minimum ever changes.
 */
import COMMON_PASSWORD_LIST from './common-passwords.json';

let commonPasswords: ReadonlySet<string> | undefined;

/** Loaded into a Set on first use (once per process). */
function commonPasswordSet(): ReadonlySet<string> {
  commonPasswords ??= new Set(COMMON_PASSWORD_LIST);
  return commonPasswords;
}

/** Case-insensitive membership test against the bundled list. */
export function isCommonPassword(password: string): boolean {
  return commonPasswordSet().has(password.toLowerCase());
}

/** Number of distinct entries (for tests and diagnostics). */
export function commonPasswordCount(): number {
  return commonPasswordSet().size;
}
