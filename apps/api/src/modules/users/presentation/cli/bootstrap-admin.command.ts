import type { BootstrapAdminInput } from '../../application/use-cases/bootstrap-admin.command';

/*
 * `admin:bootstrap` (design §5 BootstrapAdmin):
 *
 *   printf '%s' "$ADMIN_PASSWORD" | pnpm --filter @udemy/api cli admin:bootstrap \
 *     --email admin@udemy.local --display-name "Udemy Admin" --password-stdin
 *
 * The password is only ever read from stdin (never argv: it would show up in `ps` and shell
 * history) and is never printed. Output on success: one JSON line `{ userId, created, granted }`.
 */

export const BOOTSTRAP_ADMIN_COMMAND = 'admin:bootstrap';

export const BOOTSTRAP_ADMIN_USAGE = [
  `Usage: pnpm --filter @udemy/api cli ${BOOTSTRAP_ADMIN_COMMAND} --email <email> --display-name <name> --password-stdin`,
  '',
  'Idempotently ensures an ADMIN account: creates it (email verified) when the email is',
  'unknown, then grants ADMIN. The password is read from stdin, e.g.',
  `  printf '%s' "$ADMIN_PASSWORD" | pnpm --filter @udemy/api cli ${BOOTSTRAP_ADMIN_COMMAND} ...`,
].join('\n');

/** Bad command line: print the usage, exit code 2. */
export class CliUsageError extends Error {}

export interface BootstrapAdminArgs {
  readonly email: string;
  readonly displayName: string;
}

const VALUE_FLAGS = { '--email': 'email', '--display-name': 'displayName' } as const;
type ValueFlag = keyof typeof VALUE_FLAGS;

function isValueFlag(flag: string): flag is ValueFlag {
  return Object.hasOwn(VALUE_FLAGS, flag);
}

/**
 * Parses the arguments after the command name. Accepts `--flag value` and `--flag=value`.
 * `--password-stdin` is mandatory: there is deliberately no `--password` flag.
 */
export function parseBootstrapAdminArgs(argv: readonly string[]): BootstrapAdminArgs {
  const values: Partial<Record<(typeof VALUE_FLAGS)[ValueFlag], string>> = {};
  let passwordStdin = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--password-stdin') {
      passwordStdin = true;
      continue;
    }
    if (arg === '--password' || arg.startsWith('--password=')) {
      throw new CliUsageError('Passwords are never accepted as arguments: use --password-stdin.');
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!isValueFlag(flag)) throw new CliUsageError(`Unknown argument: ${arg}`);
    let value: string | undefined;
    if (eq === -1) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new CliUsageError(`${flag} needs a value.`);
    }
    values[VALUE_FLAGS[flag]] = value;
  }

  if (values.email === undefined) throw new CliUsageError('--email is required.');
  if (values.displayName === undefined) throw new CliUsageError('--display-name is required.');
  if (!passwordStdin) throw new CliUsageError('--password-stdin is required.');
  return { email: values.email, displayName: values.displayName };
}

/**
 * Reads the whole of stdin as the password. One trailing newline (`echo`, here-strings) is
 * removed, nothing else: spaces are significant in passwords. Refuses an interactive
 * terminal, where the password would be echoed.
 */
export async function readPasswordFromStdin(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (stdin.isTTY === true) {
    throw new CliUsageError('--password-stdin needs the password piped in (stdin is a terminal).');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  const password = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (password === '') throw new CliUsageError('No password on stdin.');
  return password;
}

export function toBootstrapAdminInput(
  args: BootstrapAdminArgs,
  password: string,
): BootstrapAdminInput {
  return { email: args.email, displayName: args.displayName, password };
}
