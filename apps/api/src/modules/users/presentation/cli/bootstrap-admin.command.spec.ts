import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CliUsageError,
  parseBootstrapAdminArgs,
  readPasswordFromStdin,
} from './bootstrap-admin.command';

describe('admin:bootstrap arguments', () => {
  it('accepts --flag value and --flag=value', () => {
    expect(
      parseBootstrapAdminArgs([
        '--email',
        'admin@udemy.local',
        '--display-name=Udemy Admin',
        '--password-stdin',
      ]),
    ).toEqual({ email: 'admin@udemy.local', displayName: 'Udemy Admin' });
  });

  it.each([
    [['--display-name', 'A', '--password-stdin'], '--email is required'],
    [['--email', 'a@b.c', '--password-stdin'], '--display-name is required'],
    [['--email', 'a@b.c', '--display-name', 'A'], '--password-stdin is required'],
    [['--email', '--display-name', 'A', '--password-stdin'], '--email needs a value'],
    [['--email', 'a@b.c', '--display-name', 'A', '--password-stdin', '--x'], 'Unknown argument'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseBootstrapAdminArgs(argv)).toThrow(CliUsageError);
    expect(() => parseBootstrapAdminArgs(argv)).toThrow(message);
  });

  it('never accepts a password on the command line', () => {
    for (const argv of [
      ['--email', 'a@b.c', '--display-name', 'A', '--password', 'secret'],
      ['--email', 'a@b.c', '--display-name', 'A', '--password=secret'],
    ]) {
      expect(() => parseBootstrapAdminArgs(argv)).toThrow('--password-stdin');
    }
  });
});

describe('readPasswordFromStdin', () => {
  it('reads everything and strips exactly one trailing newline', async () => {
    await expect(readPasswordFromStdin(Readable.from(['pass ', 'word\n']))).resolves.toBe(
      'pass word',
    );
    await expect(readPasswordFromStdin(Readable.from(['pw\r\n']))).resolves.toBe('pw');
    await expect(readPasswordFromStdin(Readable.from(['pw\n\n']))).resolves.toBe('pw\n');
  });

  it('refuses an empty stdin and an interactive terminal', async () => {
    await expect(readPasswordFromStdin(Readable.from(['\n']))).rejects.toThrow(CliUsageError);
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    await expect(readPasswordFromStdin(tty)).rejects.toThrow('terminal');
  });
});
