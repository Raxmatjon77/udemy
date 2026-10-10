import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TranscoderEnv } from './transcoder-env.schema';

/** Typed, read-only access to the validated env. */
@Injectable()
export class TranscoderConfigService {
  constructor(private readonly config: ConfigService<TranscoderEnv, true>) {}

  get<TKey extends keyof TranscoderEnv>(key: TKey): TranscoderEnv[TKey] {
    return this.config.get<TranscoderEnv[TKey]>(key);
  }
}
