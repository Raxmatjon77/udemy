import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnv } from './api-env.schema';

/**
 * Typed, read-only access to the validated env. Inject this instead of ConfigService:
 * keys are checked at compile time and values already have their parsed types.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<ApiEnv, true>) {}

  get<TKey extends keyof ApiEnv>(key: TKey): ApiEnv[TKey] {
    return this.config.get<ApiEnv[TKey]>(key);
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
}
