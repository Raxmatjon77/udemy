import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type Database } from './database.constants';
import { InjectDatabase } from './inject-database.decorator';

/** Closes the pg pool when the app shuts down (needs `app.enableShutdownHooks()`). */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseLifecycle.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    this.logger.log('Database pool closed');
  }
}
