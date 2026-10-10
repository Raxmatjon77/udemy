import {
  type DynamicModule,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailEnv } from './mail-env.schema';
import { Mailer } from './mailer';
import { SmtpMailer } from './smtp-mailer';

/** Closes the SMTP pool on shutdown (needs `app.enableShutdownHooks()`). */
@Injectable()
export class MailLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(MailLifecycle.name);

  constructor(private readonly mailer: Mailer) {}

  onApplicationShutdown(): void {
    if (this.mailer instanceof SmtpMailer) {
      this.mailer.close();
      this.logger.log('SMTP transport closed');
    }
  }
}

/**
 * Global module that binds the `Mailer` port to the SMTP adapter. Import once in the root
 * module: `MailModule.forRoot()`. Requires the global ConfigModule with `mailEnvShape`
 * (SMTP_HOST, SMTP_PORT, MAIL_FROM) in the app's env schema.
 */
@Module({})
export class MailModule {
  static forRoot(): DynamicModule {
    return {
      module: MailModule,
      global: true,
      providers: [
        {
          provide: Mailer,
          inject: [ConfigService],
          // nodemailer connects lazily (on the first send), so this never blocks bootstrap.
          useFactory: (config: ConfigService<MailEnv, true>): Mailer =>
            new SmtpMailer({
              host: config.get('SMTP_HOST', { infer: true }),
              port: config.get('SMTP_PORT', { infer: true }),
              from: config.get('MAIL_FROM', { infer: true }),
            }),
        },
        MailLifecycle,
      ],
      exports: [Mailer],
    };
  }
}
