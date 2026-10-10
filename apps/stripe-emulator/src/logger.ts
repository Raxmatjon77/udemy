/** A tiny JSON-lines logger (stdout); the emulator has no framework and no log dependencies. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function jsonLogger(minLevel: LogLevel = 'info'): Logger {
  return {
    log(level, message, fields = {}): void {
      if (ORDER[level] < ORDER[minLevel]) return;
      const line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        service: 'stripe-emulator',
        msg: message,
        ...fields,
      });
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
    },
  };
}

export const silentLogger: Logger = { log: () => undefined };

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}
