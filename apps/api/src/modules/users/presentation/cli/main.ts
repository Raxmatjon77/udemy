import { NestFactory } from '@nestjs/core';
import { DomainError } from '@udemy/nest-common/errors';
import { AppModule } from '../../../../app.module';
import { BootstrapAdminCommand } from '../../application/use-cases/bootstrap-admin.command';
import {
  BOOTSTRAP_ADMIN_COMMAND,
  BOOTSTRAP_ADMIN_USAGE,
  CliUsageError,
  parseBootstrapAdminArgs,
  readPasswordFromStdin,
  toBootstrapAdminInput,
} from './bootstrap-admin.command';

/**
 * Entry point of `pnpm --filter @udemy/api cli <command> ...` (dist/modules/users/presentation/
 * cli/main.js; run `pnpm --filter @udemy/api build` first). Boots the AppModule as a plain
 * application context (no HTTP server), runs one command and exits:
 * 0 = success, 1 = the command failed, 2 = bad command line.
 */
async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${BOOTSTRAP_ADMIN_USAGE}\n`);
    return command === undefined ? 2 : 0;
  }
  if (command !== BOOTSTRAP_ADMIN_COMMAND) {
    throw new CliUsageError(`Unknown command: ${command}`);
  }

  // Validate the command line and read the password before booting anything.
  const args = parseBootstrapAdminArgs(rest);
  const password = await readPasswordFromStdin();

  // stdout carries only the JSON result: keep pino (stdout) quiet unless asked otherwise.
  process.env.LOG_LEVEL = process.env.CLI_LOG_LEVEL ?? 'error';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const result = await app
      .get(BootstrapAdminCommand)
      .execute(toBootstrapAdminInput(args, password));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } finally {
    await app.close();
  }
}

function report(error: unknown): number {
  if (error instanceof CliUsageError) {
    process.stderr.write(`${error.message}\n\n${BOOTSTRAP_ADMIN_USAGE}\n`);
    return 2;
  }
  if (error instanceof DomainError) {
    const issues = 'issues' in error ? (error as { issues: unknown }).issues : undefined;
    process.stderr.write(
      `${JSON.stringify({ error: error.code, message: error.message, issues })}\n`,
    );
    return 1;
  }
  // Never echo inputs (the password) here: only the error itself.
  process.stderr.write(
    `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.exitCode = report(error);
  });
