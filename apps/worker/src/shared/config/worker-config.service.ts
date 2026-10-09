import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from './worker-env.schema';

/** Typed, read-only access to the validated env (see AppConfigService in the api). */
@Injectable()
export class WorkerConfigService {
  constructor(private readonly config: ConfigService<WorkerEnv, true>) {}

  get<TKey extends keyof WorkerEnv>(key: TKey): WorkerEnv[TKey] {
    return this.config.get<WorkerEnv[TKey]>(key);
  }
}
